'use strict';
// ========================================================
// yapson-bot7-f — Multi-utilisateurs
// Logique: fournisseur par fournisseur, réseau auto-détecté
// Confirmation avec fichier image obligatoire
// Timeout payout: 2 minutes max, passe au suivant si échec
// ========================================================

const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const crypto   = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT       = parseInt(process.env.PORT || '8080', 10);
let   ADMIN_USER = process.env.ADMIN_USER || 'admin';
let   ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const REPORT_ID  = process.env.REPORT_ID  || '1';

// — Sessions ——————————————————————————————————
const sessions = {};
function createSession(userId, isAdmin) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { userId, isAdmin, expires: Date.now() + 8*3600*1000 };
  return token;
}
function getSession(req) {
  const m = (req.headers.cookie||'').match(/session=([a-f0-9]{64})/);
  if (!m) return null;
  const s = sessions[m[1]];
  if (!s || s.expires < Date.now()) return null;
  return s;
}
function requireLogin(req, res, next) { const s=getSession(req); if(!s) return res.redirect('/login'); req.session=s; next(); }
function requireAdmin(req, res, next) { const s=getSession(req); if(!s||!s.isAdmin) return res.redirect('/login'); req.session=s; next(); }

// — Stockage utilisateurs ————————————————————
const users = {};
function saveUser(u) { users[u.userId] = u; }
function getUser(userId) { return users[userId] || null; }
function getAllUsers() { return Object.values(users); }

// — Utilitaires ——————————————————————————————
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ulog(u, type, message) {
  const ts = new Date().toISOString().replace('T',' ').substring(0,19);
  u.logs.push({ts,type,message});
  if (u.logs.length > 500) u.logs.shift();
  console.log(`[${u.userId}][${type.toUpperCase()}]${ts}—${message}`);
}

// — Cartographie réseau ——————————————————————
const NET_UUIDS = {
  'MOOV CI'  : '24462fd9-c8e2-42f2-a95f-119844bc2ada',
  'MTN CI'   : '77e8e729-a0f1-4e1b-8614-168c77f4b101',
  'ORANGE CI': '938988bf-d571-4eac-befb-40644c20976a',
  'Orangeint': '6fbc14c6-2b0b-431a-afce-2c371b33b2a3',
  'Wave'     : '97847ae3-6c50-4116-a6da-a69695afbaaa',
};
function detectNetwork(title) {
  const t = (title||'').toLowerCase();
  if (t.includes('wave'))   return 'Wave';
  if (t.includes('mtn'))    return 'MTN CI';
  if (t.includes('moov'))   return 'MOOV CI';
  if (t.includes('orange')) return 'Orangeint';
  return 'Orangeint';
}

// — Utilitaires cookies ——————————————————————
function parseCookies(raw) {
  if (!raw) return '';
  let s = raw.trim().replace(/^\(([^)]*)\)\s*/, '').replace(/^[^[a-zA-Z]+/, '').trim();
  if (!s) return '';
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.filter(c=>c.name&&c.value!==undefined)
        .map(c=>c.name.trim()+'='+String(c.value).replace(/[\r\n\t]/g,'').replace(/[^\x20-\x7E]/g,'').trim()).join('; ');
    } catch(e) {}
  }
  return s.replace(/[\r\n]/g,'').trim();
}

function mgmtH(u) {
  return {
    'Accept'           : 'application/json, text/plain, */*',
    'Content-Type'     : 'application/json',
    'X-Requested-With' : 'XMLHttpRequest',
    'X-Time-Zone'      : 'GMT+00',
    'Cookie'           : parseCookies(u.cfg.mgmtCookies),
    'User-Agent'       : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Referer'          : 'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal',
    'Origin'           : 'https://my-managment.com',
    ...u.cfg.getHeaders(),
  };
}

function yapH(u) {
  return {
    'Accept'       : 'application/json, text/plain, */*',
    'Content-Type' : 'application/json',
    'Authorization': `Token ${u.cfg.yapToken}`,
  };
}

// — Fetch retraits depuis my-managment ————————
async function fetchWithdrawals(u) {
  const res = await fetch('https://my-managment.com/admin/banktransfer/getallbanksbysubagentid', {
    method : 'POST',
    headers: mgmtH(u),
    body   : JSON.stringify({ id: null, ref_id: 1 }),
  }).catch(()=>({status:0}));
  if (!res || res.status === 0) return [];
  const text = await res.text().catch(()=>'');
  try {
    const j = JSON.parse(text);
    if (!Array.isArray(j)) return [];
    return j.filter(r => r.status === 'pending' || r.status === 'PENDING');
  } catch(e) { return []; }
}

// — Groupement par fournisseur ————————————————
function groupBySubagent(rows, cd_map) {
  const groups = {};
  for (const row of rows) {
    const pm = row.phone_number ? [row.phone_number] : [];
    const cd = cd_map ? cd_map[row.id] : null;
    const sid = row.subagent_id;
    if (!sid) continue;
    const netTitle = row.network_name || row.network || '';
    const filesRequired = cd?.files_required || 0;
    const subagentName = row.subagent || `Fournisseur_${sid}`;
    if (!pm || pm.length <= 0 || !cd || !sid) continue;
    if (!groups[sid]) groups[sid] = { subagent_id:sid, subagentName, netTitle, network:detectNetwork(netTitle), filesRequired, items:[] };
    groups[sid].items.push({ phone:pm[0], montant:row.montant||row.amount, confirmData:cd, netTitle });
  }
  return groups;
}

// — Décaissement yapson ———————————————————————
async function payout(u, item, network) {
  const uuid = NET_UUIDS[network] || NET_UUIDS['Orangeint'];
  const res  = await fetch('https://connect.yapson.net/api/aggregator/payout/', {
    method : 'POST', headers: yapH(u),
    body   : JSON.stringify({ amount:item.montant, recipient_phone:item.phone, network:uuid }),
  });
  const body = await res.json().catch(()=>({}));
  ulog(u, 'info', `  🔎 Payout réponse [${res.status}]: ${JSON.stringify(body).substring(0,120)}`);
  if (res.status===200||res.status===201) {
    const uid = body.uid || body.id || body.reference || null;
    return { ok:true, uid, phone:item.phone, montant:item.montant };
  }
  return { ok:false, err:JSON.stringify(body).substring(0,100) };
}

// — Attendre SUCCESS — timeout 2 minutes, passe au suivant si échec —
async function waitForSuccess(u, uid, phone, maxWait=120000) {
  const start = Date.now();
  function normalizePhone(p) {
    const s = String(p).replace(/[^0-9]/g,'');
    if (s.startsWith('225')) return s.substring(3);
    if (s.startsWith('0') && s.length===10) return s;
    return s;
  }
  const phoneNorm = normalizePhone(phone);
  while (Date.now() - start < maxWait) {
    await sleep(5000);
    if (Date.now() - start >= maxWait) break;
    try {
      const res = await fetch('https://connect.yapson.net/api/aggregator/transactions/?limit=20', {
        headers: yapH(u),
      });
      const body = await res.json().catch(()=>({}));
      const txs = body.results || body.data || (Array.isArray(body) ? body : []);
      if (uid) {
        const tx = txs.find(t => t.uid===uid || t.id===uid || t.reference===uid);
        if (tx) {
          if (tx.status==='SUCCESS'||tx.status==='COMPLETED'||tx.status==='success') return { ok:true, tx };
          if (tx.status==='FAILED'||tx.status==='REJECTED'||tx.status==='failed')    return { ok:false, skip:true, err:`Statut: ${tx.status}` };
        }
      } else {
        const tx = txs.find(t => {
          const tp = normalizePhone(t.recipient_phone||t.phone||'');
          return tp === phoneNorm && (t.status==='SUCCESS'||t.status==='COMPLETED'||t.status==='success');
        });
        if (tx) return { ok:true, tx };
      }
    } catch(e) { ulog(u, 'warn', `waitForSuccess erreur: ${e.message}`); }
  }
  return { ok:false, skip:true, err:'Timeout 2min' };
}

// — Génération capture nette avec node-canvas ————————————————
function generateTxScreenshot(tx) {
  const phone   = String(tx?.recipient_phone || tx?.phone || '');
  const amount  = String(tx?.amount || tx?.montant || '');
  const ref     = String(tx?.uid || tx?.id || tx?.reference || '');
  const network = String(tx?.network_name || tx?.network || 'Mobile Money');
  const dt      = tx?.created_at || tx?.date || new Date().toISOString();
  const dateMatch = dt.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})/);
  const dateFmt   = dateMatch
    ? `le ${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]} ${dateMatch[4]}`
    : dt;
  const idTx = String(ref).replace(/[^0-9A-Za-z]/gi,'').slice(-10).toUpperCase();

  try {
    const { createCanvas } = require('canvas');
    const W = 640, H = 400;
    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    // Helper arrondi
    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x+r, y);
      ctx.lineTo(x+w-r, y);
      ctx.quadraticCurveTo(x+w, y, x+w, y+r);
      ctx.lineTo(x+w, y+h-r);
      ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
      ctx.lineTo(x+r, y+h);
      ctx.quadraticCurveTo(x, y+h, x, y+h-r);
      ctx.lineTo(x, y+r);
      ctx.quadraticCurveTo(x, y, x+r, y);
      ctx.closePath();
    }

    // Couleurs réseau
    const netBg = network.toLowerCase().includes('wave')   ? '#1e88ff'
                : network.toLowerCase().includes('mtn')    ? '#ffd700'
                : network.toLowerCase().includes('moov')   ? '#0088cc'
                : '#ff6b00';
    const netFg = network.toLowerCase().includes('mtn')    ? '#333' : '#fff';

    // Fond général
    ctx.fillStyle = '#f0f2f5';
    ctx.fillRect(0, 0, W, H);

    // Carte principale blanche
    ctx.fillStyle = '#ffffff';
    roundRect(18, 18, W-36, H-36, 12);
    ctx.fill();
    ctx.strokeStyle = '#d8dde6';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Bande colorée gauche (réseau)
    ctx.fillStyle = netBg;
    roundRect(18, 18, 7, H-36, 6);
    ctx.fill();

    // — Ligne 1 : Badge SMS + Date —
    // Badge SMS
    ctx.fillStyle = '#e3f2fd';
    roundRect(38, 34, 66, 26, 5);
    ctx.fill();
    ctx.fillStyle = '#1565c0';
    ctx.font = 'bold 13px Arial, sans-serif';
    ctx.fillText('📱 SMS', 44, 51);

    // Date droite
    ctx.fillStyle = '#9e9e9e';
    ctx.font = '12px Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(dateFmt, W-30, 51);
    ctx.textAlign = 'left';

    // Séparateur
    ctx.fillStyle = '#eeeeee';
    ctx.fillRect(38, 68, W-56, 1);

    // — Ligne 2 : Téléphone + Réseau —
    // Badge téléphone fond orange pâle
    ctx.fillStyle = '#fff3e0';
    roundRect(38, 78, 260, 36, 6);
    ctx.fill();
    ctx.fillStyle = '#e65100';
    ctx.font = 'bold 15px Arial, sans-serif';
    ctx.fillText(`📞 +225 ${phone}`, 48, 101);

    // Badge réseau
    ctx.fillStyle = netBg;
    roundRect(W-148, 78, 118, 36, 6);
    ctx.fill();
    ctx.fillStyle = netFg;
    ctx.font = 'bold 13px Arial, sans-serif';
    ctx.fillText(network.substring(0,12), W-138, 101);

    // — Corps principal —
    // Texte envoi
    ctx.fillStyle = '#212121';
    ctx.font = '15px Arial, sans-serif';
    ctx.fillText(`Vous avez envoyé ${amount} FCFA au`, 38, 138);
    ctx.fillStyle = '#1565c0';
    ctx.font = 'bold 16px Arial, sans-serif';
    ctx.fillText(`+225 ${phone}`, 38, 160);

    // Date/heure
    ctx.fillStyle = '#757575';
    ctx.font = '13px Arial, sans-serif';
    ctx.fillText(dateFmt, 38, 182);

    // Séparateur fin
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(38, 196, W-76, 1);

    // Détails transaction
    ctx.fillStyle = '#2e7d32';
    ctx.font = 'bold 15px Arial, sans-serif';
    ctx.fillText(`Montant : ${amount} FCFA`, 38, 218);

    ctx.fillStyle = '#424242';
    ctx.font = '14px Arial, sans-serif';
    ctx.fillText(`ID Transaction : ${idTx}`, 38, 242);

    ctx.fillStyle = '#9e9e9e';
    ctx.font = '12px Arial, sans-serif';
    ctx.fillText(`Réf : ${ref.substring(0,34)}`, 38, 264);

    // — Badge SUCCESS —
    ctx.fillStyle = '#e8f5e9';
    roundRect(W-178, H-58, 148, 32, 8);
    ctx.fill();
    ctx.fillStyle = '#2e7d32';
    ctx.fillRect(W-178, H-58, 5, 32);
    ctx.fillStyle = '#1b5e20';
    ctx.font = 'bold 14px Arial, sans-serif';
    ctx.fillText('✅  OK  SUCCESS', W-168, H-36);

    return { buffer: canvas.toBuffer('image/png'), mimeType:'image/png', filename:'image.png' };

  } catch(e) {
    // Fallback SVG si canvas indispo
    return generateSvgFallback(phone, amount, idTx, dateFmt, network, ref);
  }
}

function generateSvgFallback(phone, amount, idTx, dateFmt, network, ref) {
  const netColor = network.includes('Wave') ?'#1e88ff': network.includes('MTN') ?'#ffd700': network.includes('MOOV') ?'#0088cc':'#ff6b00';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='640' height='400'>
<rect width='640' height='400' fill='#f0f2f5'/>
<rect x='18' y='18' width='604' height='364' rx='10' fill='white' stroke='#d8dde6'/>
<rect x='18' y='18' width='7' height='364' fill='${netColor}'/>
<rect x='38' y='34' width='66' height='26' rx='5' fill='#e3f2fd'/>
<text x='46' y='51' font-family='Arial' font-size='13' font-weight='bold' fill='#1565c0'>SMS</text>
<text x='610' y='51' font-family='Arial' font-size='12' fill='#9e9e9e' text-anchor='end'>${dateFmt}</text>
<rect x='38' y='68' width='564' height='1' fill='#eee'/>
<rect x='38' y='78' width='260' height='36' rx='6' fill='#fff3e0'/>
<text x='48' y='101' font-family='Arial' font-size='15' font-weight='bold' fill='#e65100'>+225 ${phone}</text>
<rect x='492' y='78' width='130' height='36' rx='6' fill='${netColor}'/>
<text x='502' y='101' font-family='Arial' font-size='13' font-weight='bold' fill='white'>${network.substring(0,12)}</text>
<text x='38' y='138' font-family='Arial' font-size='15' fill='#212121'>Vous avez envoye ${amount} FCFA au</text>
<text x='38' y='160' font-family='Arial' font-size='16' font-weight='bold' fill='#1565c0'>+225 ${phone}</text>
<text x='38' y='182' font-family='Arial' font-size='13' fill='#757575'>${dateFmt}</text>
<rect x='38' y='196' width='564' height='1' fill='#f5f5f5'/>
<text x='38' y='218' font-family='Arial' font-size='15' font-weight='bold' fill='#2e7d32'>Montant : ${amount} FCFA</text>
<text x='38' y='242' font-family='Arial' font-size='14' fill='#424242'>ID Transaction : ${idTx}</text>
<text x='38' y='264' font-family='Arial' font-size='12' fill='#9e9e9e'>Ref : ${ref.substring(0,34)}</text>
<rect x='462' y='342' width='148' height='32' rx='8' fill='#e8f5e9'/>
<rect x='462' y='342' width='5' height='32' fill='#2e7d32'/>
<text x='474' y='363' font-family='Arial' font-size='14' font-weight='bold' fill='#1b5e20'>OK  SUCCESS</text>
</svg>`;
  return { buffer: Buffer.from(svg, 'utf8'), mimeType:'image/svg+xml', filename:'image.svg' };
}

// — Confirmation avec fichier ————————————————
async function confirmWithFile(u, item, fileBuffer, mimeType, filename) {
  const cd = item.confirmData;
  const fs = require('fs'), os = require('os'), path = require('path');
  await fetch('https://my-managment.com/admin/banktransfer/getallbanksbysubagentid', {
    method :'POST', headers:mgmtH(u), body:JSON.stringify({id:cd.subagent_id,ref_id:cd.ref_id||1}),
  }).catch(()=>{});
  await sleep(400);
  const uniqueName = `confirm_${Date.now()}_${Math.random().toString(36).substring(2,8)}.png`;
  const tmpFile    = path.join(os.tmpdir(), uniqueName);
  fs.writeFileSync(tmpFile, fileBuffer);
  const fd = new FormData();
  fd.append('code','epay'); fd.append('id',String(cd.id)); fd.append('comment',''); fd.append('commentId','null'); fd.append('otherComment',''); fd.append('is_out','true');
  fd.append('subagent_id',String(cd.subagent_id)); fd.append('ref_id',String(cd.ref_id||1)); fd.append('bank_id',cd.bank_id?String(cd.bank_id):'null');
  fd.append('report_id',u.cfg.reportId); fd.append('user_id',String(cd.user_id||''));
  fd.append('approve_doc', fs.createReadStream(tmpFile),{filename:'image.png',contentType:mimeType||'image/png'});
  const h = {'Accept':'application/json, text/plain, */*','X-Requested-With':'XMLHttpRequest','X-Time-Zone':'GMT+00','Cookie':parseCookies(u.cfg.mgmtCookies),'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36','Referer':'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal','Origin':'https://my-managment.com',...fd.getHeaders()};
  const result = {};
  try {
    const res = await fetch('https://my-managment.com/admin/banktransfer/approvemoney',{method:'POST',headers:h,body:fd});
    if (res.status===200||res.status===302) {
      const text = await res.text();
      if (text.startsWith('<')||text.includes('<!DOCTYPE')) { result={ok:true}; }
      else { try { const j=JSON.parse(text); const m=j.message||JSON.stringify(j); result=m.toLowerCase().includes('photo confirmation')?{ok:false,err:`Photo refusée: ${m.substring(0,120)}`}:{ok:j.success===true,err:m.substring(0,120)}; } catch(e){result={ok:true};} }
    } else { const et=await res.text().catch(()=>''); result={ok:false,err:`HTTP ${res.status} — ${et.substring(0,80)}`}; }
  } finally { try { require('fs').unlinkSync(tmpFile); } catch(e){} }
  return result;
}

// — Confirmation sans fichier ————————————————
async function confirmWithoutFile(u, item) {
  const cd = item.confirmData;
  await fetch('https://my-managment.com/admin/banktransfer/getallbanksbysubagentid', {
    method :'POST', headers:mgmtH(u), body:JSON.stringify({id:cd.subagent_id,ref_id:cd.ref_id||1}),
  }).catch(()=>{});
  await sleep(400);
  const fd = new FormData();
  fd.append('code','epay'); fd.append('id',String(cd.id)); fd.append('comment',''); fd.append('commentId','null'); fd.append('otherComment',''); fd.append('is_out','true');
  fd.append('subagent_id',String(cd.subagent_id)); fd.append('ref_id',String(cd.ref_id||1)); fd.append('bank_id',cd.bank_id?String(cd.bank_id):'null');
  fd.append('report_id',u.cfg.reportId); fd.append('user_id',String(cd.user_id||''));
  const h = {'Accept':'application/json, text/plain, */*','X-Requested-With':'XMLHttpRequest','X-Time-Zone':'GMT+00','Cookie':parseCookies(u.cfg.mgmtCookies),'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36','Referer':'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal',...fd.getHeaders()};
  const res = await fetch('https://my-managment.com/admin/banktransfer/approvemoney',{method:'POST',headers:h,body:fd});
  if (res.status===200||res.status===302) {
    const text = await res.text();
    if (text.startsWith('<')||text.includes('<!DOCTYPE')) return {ok:true};
    try { const j=JSON.parse(text); return {ok:j.success===true,err:j.message||''}; } catch(e){return {ok:true};}
  }
  const et = await res.text().catch(()=>'');
  return {ok:false,err:`HTTP ${res.status} — ${et.substring(0,80)}`};
}

// — Cycle principal par utilisateur ——————————
async function runCycle(u) {
  if (u.isRunning) return;
  u.isRunning = true;
  u.stats = u.stats || { confirmed:0, missing:0, rejected:0 };
  try {
    const rows = await fetchWithdrawals(u);
    if (!rows.length) { ulog(u,'info','Aucun retrait en attente'); u.isRunning=false; return; }
    ulog(u,'info',`${rows.length} retrait(s) trouvé(s)`);

    // Construire map confirmData
    const cd_map = {};
    for (const row of rows) {
      cd_map[row.id] = {
        id          : row.id,
        subagent_id : row.subagent_id,
        ref_id      : row.ref_id || 1,
        bank_id     : row.bank_id || null,
        user_id     : row.user_id || '',
        files_required: row.files_required || 0,
      };
    }

    const groups = groupBySubagent(rows, cd_map);
    for (const sid of Object.keys(groups)) {
      const group = groups[sid];
      const { subagentName, network, filesRequired, items } = group;
      ulog(u,'info',`▶ Fournisseur: ${subagentName.substring(0,20)} (${items.length} items, réseau: ${network})`);

      for (const item of items) {
        // 1. Décaisser
        const payResult = await payout(u, item, network);
        if (!payResult.ok) {
          u.stats.missing++;
          ulog(u,'err',`  ✗ Décaissement échoué: ${item.phone} — ${payResult.err}`);
          await sleep(800);
          continue;
        }
        ulog(u,'ok',`  ✔ Décaissé: ${item.phone} → ${item.montant.toLocaleString()} FCFA (uid: ${(payResult.uid||'?').substring(0,8)}...)`);

        // 2. Attendre SUCCESS si fichier requis
        if (filesRequired) {
          ulog(u,'info',`  ⏳ Attente confirmation yapson pour ${item.phone} (max 2min)...`);
          const waitResult = await waitForSuccess(u, payResult.uid, item.phone, 120000);

          if (!waitResult.ok) {
            u.stats.missing++;
            if (waitResult.skip) {
              ulog(u,'warn',`  △ ${waitResult.err} — numéro ignoré`);
            } else {
              ulog(u,'warn',`  △ ${item.phone} — ${waitResult.err}`);
            }
            await sleep(800);
            continue;
          }

          ulog(u,'ok',`  ✔ Transaction SUCCESS: ${waitResult.tx?.uid?.substring(0,8)||'?'}`);
          const screenshot    = await generateTxScreenshot(waitResult.tx);
          const confirmResult = await confirmWithFile(u, item, screenshot.buffer, screenshot.mimeType, screenshot.filename);
          if (confirmResult.ok) { u.stats.confirmed++; ulog(u,'ok',`  ✔ Confirmé avec fichier: ${item.phone}`); }
          else { u.stats.missing++; ulog(u,'warn',`  △ Confirmation échouée: ${item.phone} — ${confirmResult.err}`); }

        } else {
          // Pas de fichier requis — mais on vérifie quand même la transaction (timeout 2min)
          ulog(u,'info',`  ⏳ Vérification transaction ${item.phone} (max 2min)...`);
          const waitResult = await waitForSuccess(u, payResult.uid, item.phone, 120000);

          if (!waitResult.ok) {
            u.stats.missing++;
            if (waitResult.skip) {
              ulog(u,'warn',`  △ ${waitResult.err} — ${item.phone} ignoré`);
            } else {
              ulog(u,'warn',`  △ ${item.phone} — ${waitResult.err}`);
            }
            await sleep(700);
            continue;
          }

          const confirmResult = await confirmWithoutFile(u, item);
          if (confirmResult.ok) { u.stats.confirmed++; ulog(u,'ok',`  ✔ Confirmé: ${item.phone}`); }
          else { u.stats.missing++; ulog(u,'warn',`  △ Manuel: ${item.phone} — ${confirmResult.err}`); }
        }
        await sleep(700);
      }
      ulog(u,'info',`✓ Fournisseur ${subagentName.substring(0,20)} terminé`);
      await sleep(1000);
    }
    ulog(u,'info',`Poll terminé — ${u.stats.confirmed} confirmés total`);
  } catch(e) {
    ulog(u,'err',`Erreur: ${e.message}`); u.stats.rejected++;
  } finally { u.isRunning=false; }
}

function startPolling(u) {
  if (u.pollTimer) return; u.botActive=true;
  ulog(u,'ok',`Bot démarré — ${u.cfg.pollInterval}s`);
  runCycle(u); u.pollTimer=setInterval(()=>runCycle(u), u.cfg.pollInterval*1000);
}
function stopPolling(u) {
  if (u.pollTimer) { clearInterval(u.pollTimer); u.pollTimer=null; }
  u.botActive=false; ulog(u,'warn','Bot arrêté');
}

// — CSS partagé ——————————————————————————————
const CSS_COMMON = `
:root{--bg:#0d1117;--s1:#161b22;--s2:#21262d;--s3:#30363d;--t:#e6edf3;--m:#8b949e;--g:#3fb950;--b:#58a6ff;--o:#f0883e;--r:#f85149;--p:#bc8cff}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);font-family:'Courier New',monospace;color:var(--t);font-size:13px;padding:20px}
.wrap{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.card{background:var(--s1);border:1px solid var(--s3);border-radius:10px;overflow:hidden}
.ch{padding:12px 16px;border-bottom:1px solid var(--s3);font-size:10px;font-weight:700;letter-spacing:2px;color:var(--m);text-transform:uppercase;display:flex;align-items:center;gap:8px}
.cb{padding:16px}.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:600px){.g2{grid-template-columns:1fr}}
.frow{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
label{font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--m);text-transform:uppercase}
input,select,textarea{width:100%;background:var(--s2);border:1px solid var(--s3);color:var(--t);border-radius:6px;padding:8px 10px;font-family:inherit;font-size:12px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--b)}
button{display:inline-block;padding:9px 18px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:1px;cursor:pointer;border:none;text-decoration:none;text-transform:uppercase}
.bg{background:var(--g);color:#000}.bb{background:var(--b);color:#000}.br{background:var(--r);color:#fff}.bo{background:var(--o);color:#000}.bp{background:var(--p);color:#000}
.stat{background:var(--s2);border-radius:8px;padding:14px;text-align:center}
.sv{font-size:22px;font-weight:700;color:var(--g)}.sl{font-size:10px;color:var(--m);margin-top:4px}
.log-box{height:260px;overflow-y:auto;background:var(--s2);border-radius:6px;padding:10px;font-size:11px;line-height:1.6}
.log-ok{color:var(--g)}.log-err{color:var(--r)}.log-warn{color:var(--o)}.log-info{color:var(--b)}
.badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:700}
.b-on{background:#1a4731;color:var(--g)}.b-off{background:#3d1a1a;color:var(--r)}
nav{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px}
nav a{color:var(--b);text-decoration:none;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 0;border-bottom:2px solid transparent}
nav a.active{border-color:var(--b);color:var(--t)}
.alert{padding:10px 14px;border-radius:6px;font-size:12px;margin-bottom:12px}
.a-ok{background:#1a4731;border:1px solid var(--g);color:var(--g)}.a-err{background:#3d1a1a;border:1px solid var(--r);color:var(--r)}
`;

// — Routes HTML ——————————————————————————————
app.get('/login', (req,res)=>{
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bot7-F Login</title><style>${CSS_COMMON}
  .login-box{max-width:380px;margin:60px auto}h1{font-size:18px;color:var(--b);margin-bottom:20px;text-align:center}
  </style></head><body><div class="login-box"><div class="card">
  <div class="ch">🤖 YAPSON BOT7-F — CONNEXION</div><div class="cb">
  <h1>Accès Bot</h1>
  ${req.query.err?`<div class="alert a-err">Identifiants incorrects</div>`:''}
  <form method="POST" action="/login">
  <div class="frow"><label>Identifiant</label><input name="user" autofocus></div>
  <div class="frow"><label>Mot de passe</label><input type="password" name="pass"></div>
  <button class="bg" type="submit" style="width:100%;margin-top:8px">CONNEXION</button>
  </form></div></div></div></body></html>`);
});

app.post('/login', (req,res)=>{
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = createSession(user, true);
    res.setHeader('Set-Cookie',`session=${token};HttpOnly;Path=/;Max-Age=28800`);
    return res.redirect('/');
  }
  // Vérifier utilisateurs normaux
  const u = Object.values(users).find(u => u.userId===user && u.cfg.password===pass);
  if (u) {
    const token = createSession(user, false);
    res.setHeader('Set-Cookie',`session=${token};HttpOnly;Path=/;Max-Age=28800`);
    return res.redirect('/bot');
  }
  res.redirect('/login?err=1');
});

app.get('/logout', (req,res)=>{
  const m = (req.headers.cookie||'').match(/session=([a-f0-9]{64})/);
  if (m) delete sessions[m[1]];
  res.setHeader('Set-Cookie','session=;HttpOnly;Path=/;Max-Age=0');
  res.redirect('/login');
});

// — Page admin principale ————————————————————
app.get('/', requireAdmin, (req,res)=>{
  const allU = getAllUsers();
  const rows = allU.map(u=>`
    <tr>
      <td>${u.userId}</td>
      <td><span class="badge ${u.botActive?'b-on':'b-off'}">${u.botActive?'ACTIF':'ARRÊTÉ'}</span></td>
      <td>${u.stats?.confirmed||0}</td>
      <td>${u.stats?.missing||0}</td>
      <td>${u.cfg.pollInterval}s</td>
      <td><a href="/admin/user/${u.userId}" class="btn bb" style="font-size:10px;padding:4px 10px">Gérer</a></td>
    </tr>`).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Admin Bot7-F</title><style>${CSS_COMMON}
  table{width:100%;border-collapse:collapse}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--s3);font-size:12px}
  th{font-size:10px;font-weight:700;letter-spacing:1px;color:var(--m);text-transform:uppercase}
  </style></head><body><div class="wrap">
  <div class="card"><div class="ch">⚙️ ADMIN — BOT7-F
    <div style="margin-left:auto;display:flex;gap:8px">
      <a href="/admin/new" class="btn bg">+ Ajouter Utilisateur</a>
      <a href="/logout" class="btn br">Déconnexion</a>
    </div>
  </div><div class="cb">
  <div style="display:flex;gap:12px;margin-bottom:16px">
    <div class="stat"><div class="sv">${allU.length}</div><div class="sl">Utilisateurs</div></div>
    <div class="stat"><div class="sv" style="color:var(--g)">${allU.filter(u=>u.botActive).length}</div><div class="sl">Actifs</div></div>
    <div class="stat"><div class="sv" style="color:var(--b)">${allU.reduce((s,u)=>s+(u.stats?.confirmed||0),0)}</div><div class="sl">Confirmés total</div></div>
  </div>
  <table><thead><tr><th>Utilisateur</th><th>Statut</th><th>Confirmés</th><th>Manqués</th><th>Intervalle</th><th>Action</th></tr></thead>
  <tbody>${rows||'<tr><td colspan="6" style="text-align:center;color:var(--m)">Aucun utilisateur</td></tr>'}</tbody></table>
  </div></div></div></body></html>`);
});

// — Créer un utilisateur ———————————————————
app.get('/admin/new', requireAdmin, (req,res)=>{
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Nouvel utilisateur</title><style>${CSS_COMMON}</style></head>
  <body><div class="wrap"><div class="card"><div class="ch">➕ NOUVEL UTILISATEUR <a href="/" style="margin-left:auto;color:var(--m);font-size:10px">← Retour</a></div>
  <div class="cb">
  ${req.query.err?'<div class="alert a-err">Identifiant déjà utilisé ou champs manquants</div>':''}
  <p style="color:var(--m);font-size:11px;margin-bottom:16px">L'admin crée l'accès (identifiant + mot de passe). L'utilisateur configurera ensuite lui-même son token et ses cookies depuis son tableau de bord.</p>
  <form method="POST" action="/admin/new">
  <div class="g2">
    <div class="frow"><label>Identifiant</label><input name="userId" required autofocus></div>
    <div class="frow"><label>Mot de passe</label><input type="password" name="password" required></div>
  </div>
  <button class="bg" type="submit" style="margin-top:8px">CRÉER LE COMPTE</button>
  </form></div></div></div></body></html>`);
});

app.post('/admin/new', requireAdmin, (req,res)=>{
  const { userId, password } = req.body;
  if (!userId||!password) return res.redirect('/admin/new?err=1');
  if (getUser(userId)) return res.redirect('/admin/new?err=1');
  const u = {
    userId, botActive:false, isRunning:false, pollTimer:null,
    logs:[], stats:{ confirmed:0, missing:0, rejected:0 },
    cfg:{ password, yapToken:'', reportId:REPORT_ID, pollInterval:60, mgmtCookies:'', getHeaders:()=>({}) },
  };
  saveUser(u);
  res.redirect('/');
});

// — Gérer un utilisateur ———————————————————
app.get('/admin/user/:id', requireAdmin, (req,res)=>{
  const u = getUser(req.params.id);
  if (!u) return res.redirect('/');
  const logs = [...u.logs].reverse().slice(0,80).map(l=>`<div class="log-${l.type}">[${l.ts}] ${escHtml(l.message)}</div>`).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Utilisateur ${u.userId}</title><style>${CSS_COMMON}</style>
  <script>function confirmDel(){return confirm('Supprimer cet utilisateur ?')}</script>
  </head><body><div class="wrap">
  <div class="card"><div class="ch">👤 ${u.userId} — <span class="badge ${u.botActive?'b-on':'b-off'}">${u.botActive?'ACTIF':'ARRÊTÉ'}</span>
    <div style="margin-left:auto;display:flex;gap:8px">
      <a href="/" style="color:var(--m);font-size:10px">← Admin</a>
    </div>
  </div><div class="cb">
  <div class="g2" style="margin-bottom:16px">
    <div class="stat"><div class="sv">${u.stats?.confirmed||0}</div><div class="sl">Confirmés</div></div>
    <div class="stat"><div class="sv" style="color:var(--r)">${u.stats?.missing||0}</div><div class="sl">Manqués</div></div>
  </div>
  <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
    ${!u.botActive?`<form method="POST" action="/admin/user/${u.userId}/start"><button class="bg" type="submit">▶ Démarrer</button></form>`
                  :`<form method="POST" action="/admin/user/${u.userId}/stop"><button class="br" type="submit">⏹ Arrêter</button></form>`}
    <form method="POST" action="/admin/user/${u.userId}/delete" onsubmit="return confirmDel()"><button class="br" type="submit">🗑 Supprimer</button></form>
  </div>
  <div class="card"><div class="ch">📋 Logs récents</div><div class="cb">
    <div class="log-box">${logs||'<div class="log-info">Aucun log</div>'}</div>
  </div></div>
  <div class="card" style="margin-top:12px"><div class="ch">✏️ Accès du compte</div><div class="cb">
  <p style="color:var(--m);font-size:11px;margin-bottom:12px">La configuration technique (token, cookies) est gérée par l'utilisateur depuis son tableau de bord.</p>
  <form method="POST" action="/admin/user/${u.userId}/update">
  <div class="g2">
    <div class="frow"><label>Nouveau mot de passe</label><input type="password" name="password" placeholder="Laisser vide = inchangé"></div>
    <div class="frow"><label>Config renseignée ?</label><div style="padding:8px 0;font-size:12px">${u.cfg.yapToken?'<span style="color:var(--g)">✔ Token OK</span>':'<span style="color:var(--r)">✗ Token manquant</span>'} &nbsp; ${u.cfg.mgmtCookies?'<span style="color:var(--g)">✔ Cookies OK</span>':'<span style="color:var(--r)">✗ Cookies manquants</span>'}</div></div>
  </div>
  <button class="bb" type="submit" style="margin-top:8px">💾 Enregistrer</button>
  </form></div></div>
  </div></div></div></body></html>`);
});

app.post('/admin/user/:id/start', requireAdmin, (req,res)=>{
  const u = getUser(req.params.id); if(!u) return res.redirect('/');
  startPolling(u); res.redirect(`/admin/user/${u.userId}`);
});
app.post('/admin/user/:id/stop', requireAdmin, (req,res)=>{
  const u = getUser(req.params.id); if(!u) return res.redirect('/');
  stopPolling(u); res.redirect(`/admin/user/${u.userId}`);
});
app.post('/admin/user/:id/delete', requireAdmin, (req,res)=>{
  const u = getUser(req.params.id); if(!u) return res.redirect('/');
  stopPolling(u); delete users[u.userId]; res.redirect('/');
});
app.post('/admin/user/:id/update', requireAdmin, (req,res)=>{
  const u = getUser(req.params.id); if(!u) return res.redirect('/');
  const { password } = req.body;
  if (password && password.trim()) u.cfg.password = password.trim();
  res.redirect(`/admin/user/${u.userId}`);
});

// — Page bot utilisateur ———————————————————
app.get('/bot', requireLogin, (req,res)=>{
  const u = getUser(req.session.userId);
  if (!u) return res.redirect('/login');
  if (req.session.isAdmin) return res.redirect('/');
  const logs = [...u.logs].reverse().slice(0,60).map(l=>`<div class="log-${l.type}">[${l.ts}] ${escHtml(l.message)}</div>`).join('');
  const cfgOk = u.cfg.yapToken && u.cfg.mgmtCookies;
  const saved = req.query.saved ? '<div class="alert a-ok">✔ Configuration enregistrée</div>' : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bot — ${u.userId}</title>
  <meta http-equiv="refresh" content="15"><style>${CSS_COMMON}</style></head>
  <body><div class="wrap">
  <div class="card"><div class="ch">🤖 BOT — ${u.userId}
    <span class="badge ${u.botActive?'b-on':'b-off'}" style="margin-left:8px">${u.botActive?'ACTIF':'ARRÊTÉ'}</span>
    <a href="/logout" style="margin-left:auto;color:var(--m);font-size:10px">Déconnexion</a>
  </div><div class="cb">
  ${!cfgOk?'<div class="alert a-err">⚠️ Configuration incomplète — renseignez votre Token et vos Cookies ci-dessous avant de démarrer</div>':''}
  <div class="g2" style="margin-bottom:16px">
    <div class="stat"><div class="sv">${u.stats?.confirmed||0}</div><div class="sl">Confirmés</div></div>
    <div class="stat"><div class="sv" style="color:var(--r)">${u.stats?.missing||0}</div><div class="sl">Manqués</div></div>
  </div>
  ${!u.botActive
    ?`<form method="POST" action="/bot/start"><button class="bg" type="submit" ${!cfgOk?'disabled style="opacity:.4;cursor:not-allowed"':''}>▶ Démarrer le Bot</button></form>`
    :`<form method="POST" action="/bot/stop"><button class="br" type="submit">⏹ Arrêter le Bot</button></form>`}
  </div></div>

  <div class="card"><div class="ch">⚙️ Ma Configuration</div><div class="cb">
  ${saved}
  <form method="POST" action="/bot/config">
  <div class="g2">
    <div class="frow"><label>Token Yapson</label><input name="yapToken" value="${escHtml(u.cfg.yapToken)}" placeholder="Token API yapson.net" required></div>
    <div class="frow"><label>Intervalle poll (s)</label><input name="pollInterval" type="number" value="${u.cfg.pollInterval||60}" min="20"></div>
    <div class="frow"><label>Nouveau mot de passe</label><input type="password" name="password" placeholder="Laisser vide = inchangé"></div>
  </div>
  <div class="frow" style="margin-top:8px"><label>Cookies my-managment.com</label><textarea name="mgmtCookies" rows="5" placeholder="Collez vos cookies ici...">${escHtml(u.cfg.mgmtCookies)}</textarea></div>
  <button class="bb" type="submit" style="margin-top:10px">💾 Enregistrer ma config</button>
  </form></div></div>

  <div class="card"><div class="ch">📋 Activité</div><div class="cb">
    <div class="log-box">${logs||'<div class="log-info">En attente de démarrage...</div>'}</div>
  </div></div>
  </div></body></html>`);
});

app.post('/bot/config', requireLogin, (req,res)=>{
  const u = getUser(req.session.userId); if(!u) return res.redirect('/login');
  const { yapToken, reportId, pollInterval, mgmtCookies, password } = req.body;
  if (yapToken    !== undefined) u.cfg.yapToken     = yapToken.trim();
  // reportId géré par variable d'environnement, pas modifiable par l'utilisateur
  if (pollInterval)              u.cfg.pollInterval = Math.max(20, parseInt(pollInterval,10)||60);
  if (mgmtCookies !== undefined) u.cfg.mgmtCookies  = mgmtCookies.trim();
  if (password && password.trim()) u.cfg.password   = password.trim();
  res.redirect('/bot?saved=1');
});

app.post('/bot/start', requireLogin, (req,res)=>{
  const u = getUser(req.session.userId); if(!u) return res.redirect('/login');
  startPolling(u); res.redirect('/bot');
});
app.post('/bot/stop', requireLogin, (req,res)=>{
  const u = getUser(req.session.userId); if(!u) return res.redirect('/login');
  stopPolling(u); res.redirect('/bot');
});

// — API admin (JSON) ———————————————————————
app.get('/api/admin/pass', requireAdmin, (req,res)=>{
  res.json({ user: ADMIN_USER });
});
app.post('/api/admin/pass', requireAdmin, (req,res)=>{
  const { newUser, newPass } = req.body;
  if (newUser) ADMIN_USER = newUser;
  if (newPass) ADMIN_PASS = newPass;
  res.json({ ok:true });
});

// — Helpers ————————————————————————————————
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// — Démarrage ——————————————————————————————
app.listen(PORT, ()=>{
  console.log(`✅ Bot7-F démarré sur le port ${PORT}`);
  console.log(`   Admin: ${ADMIN_USER} / [ADMIN_PASS]`);
});
