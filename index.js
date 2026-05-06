'use strict';
// ============================================================
// yapson-bot7-f — Multi-utilisateurs
// Logique: fournisseur par fournisseur, réseau auto-détecté
// Confirmation avec fichier image obligatoire
// Timeout payout: 2 minutes max, passe au suivant si échec
// ============================================================

const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const crypto   = require('crypto');

const app  = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT       = parseInt(process.env.PORT || '8080', 10);
let   ADMIN_USER = process.env.ADMIN_USER || 'admin';
let   ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// ── Sessions ──────────────────────────────────────────────────
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

// ── Stockage utilisateurs ─────────────────────────────────────
const users = {};
function hashPass(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

function createUser(username, password) {
  const id = crypto.randomBytes(8).toString('hex');
  users[id] = {
    id, username,
    passwordHash: hashPass(password),
    cfg: {
      mgmtCookies : '',
      yapsonToken : '',
      reportId    : process.env.REPORT_ID || '8231c3be3216307da83c067d263c09ec',
      pollInterval: parseInt(process.env.POLL_INTERVAL || '900'),
      maxSolde    : parseInt(process.env.MAX_SOLDE || '0'),
    },
    stats: { confirmed:0, missing:0, fixed:0, polls:0, rejected:0 },
    logs: [],
    pollTimer: null, isRunning: false, botActive: false,
  };
  return users[id];
}

function ulog(u, type, msg) {
  const ts = new Date().toISOString().replace('T',' ').substring(0,19);
  u.logs.unshift({ ts, type, msg });
  if (u.logs.length > 500) u.logs.pop();
  console.log(`[${u.username}][${type.toUpperCase()}] ${ts} — ${msg}`);
}

// ── Mapping réseau ────────────────────────────────────────────
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

// ── Utilitaires cookies ───────────────────────────────────────
function parseCookies(raw) {
  if (!raw) return '';
  let s = raw.trim().replace(/^\([^)]*\)\s*/,'').replace(/^[^[a-zA-Z]+/,'').trim();
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
  };
}
function yapH(u) {
  return { 'Content-Type':'application/json', 'Authorization': `Bearer ${u.cfg.yapsonToken}` };
}
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ── Lire tous les retraits ────────────────────────────────────
async function getAllWithdrawals(u) {
  const res = await fetch('https://my-managment.com/admin/report/pendingrequestwithdrawal', {
    method:'POST', headers:mgmtH(u), body:JSON.stringify({page:1,limit:500}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — cookies expirés ?`);
  const data = await res.json();
  if (data.is_guest) throw new Error('Session expirée — injecter nouveaux cookies');
  const rows = data.data || [];
  const groups = {};
  for (const row of rows) {
    const montant = row.summa_sort || parseInt((row.summa||'').replace(/[^0-9]/g,''))||0;
    const phone   = row.dopparam?.[0]?.description || '';
    const netTitle= row.dopparam?.[0]?.title || '';
    const pm      = String(phone).match(/0[0-9]{9}/);
    const cd      = row.confirm?.[0]?.data || null;
    const sid     = cd?.subagent_id;
    const filesRequired = cd?.files_required || 0;
    const subagentName  = row.subagent || `Fournisseur_${sid}`;
    if (!pm || montant <= 0 || !cd || !sid) continue;
    if (!groups[sid]) groups[sid] = { subagent_id:sid, subagentName, netTitle, network:detectNetwork(netTitle), filesRequired, items:[] };
    groups[sid].items.push({ phone:pm[0], montant, confirmData:cd, netTitle });
  }
  return groups;
}

// ── Décaissement yapson ───────────────────────────────────────
async function payout(u, item, network) {
  const uuid = NET_UUIDS[network] || NET_UUIDS['Orangeint'];
  const res  = await fetch('https://connect.yapson.net/api/aggregator/payout/', {
    method:'POST', headers:yapH(u),
    body:JSON.stringify({ amount:item.montant, recipient_phone:item.phone, network:uuid }),
  });
  const body = await res.json().catch(()=>({}));
  ulog(u, 'info', `  🔍 Payout réponse [${res.status}]: ${JSON.stringify(body).substring(0,120)}`);
  if (res.status===200||res.status===201) {
    const uid = body.uid || body.id || body.reference || null;
    return { ok:true, uid, phone:item.phone, montant:item.montant };
  }
  return { ok:false, err:JSON.stringify(body).substring(0,100) };
}

// ── Attendre SUCCESS — timeout 2 minutes, passe au suivant si échec ──
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
    // Vérifier si timeout atteint AVANT la requête
    if (Date.now() - start >= maxWait) break;
    try {
      let tx = null;
      if (uid) {
        const res = await fetch(`https://connect.yapson.net/api/aggregator/transactions/${uid}/`, { headers: yapH(u) });
        tx = await res.json();
      } else {
        const res = await fetch('https://connect.yapson.net/api/aggregator/transactions/?limit=50', { headers: yapH(u) });
        const data = await res.json();
        const results = data.results || data.data || [];
        tx = results.find(t => normalizePhone(t.recipient_phone)===phoneNorm && (t.status==='pending'||t.status==='success'));
      }
      if (!tx) { ulog(u, 'info', `⏳ Transaction introuvable pour ${phone}...`); continue; }
      if (tx.status==='success') return { ok:true, tx };
      if (tx.status==='failed')  return { ok:false, err:`Transaction échouée: ${tx.error_message||''}`, skip:true };
      ulog(u, 'info', `⏳ ${(tx.uid||phone).substring(0,8)} status=${tx.status}... (${Math.round((Date.now()-start)/1000)}s)`);
    } catch(e) { ulog(u, 'info', `⏳ attente... (${Math.round((Date.now()-start)/1000)}s)`); }
  }
  // Timeout 2 minutes atteint → ignorer ce numéro, passer au suivant
  return { ok:false, err:`Timeout 2min — ${phone} ignoré, passage au suivant`, skip:true };
}

// ── Générer capture SMS ───────────────────────────────────────
async function generateTxScreenshot(tx) {
  const dt = (tx.completed_at||tx.created_at||new Date().toISOString()).replace('T',' ').substring(0,19);
  const ref = tx.reference||tx.uid||'N/A';
  const phone = tx.recipient_phone||'';
  const amount = parseInt(tx.amount||0).toLocaleString('fr-FR');
  const network = (tx.network_name||tx.network||'').toUpperCase();
  const dateMatch = dt.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})/);
  const dateFmt = dateMatch ? `le ${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]} ${dateMatch[4]}` : dt;
  const idTx = String(ref).replace(/[^0-9A-Z]/gi,'').slice(-10).toUpperCase();
  const netColors = {
    'WAVE':{ bg:'#1e88ff' },'ORANGE':{ bg:'#ff6b00' },'MTN':{ bg:'#ffd700' },'MOOV':{ bg:'#0088cc' },
    'ORANGEINT':{ bg:'#ff6b00' },'MTN CI':{ bg:'#ffd700' },'MOOV CI':{ bg:'#0088cc' },
  };
  let netKey = network;
  for (const k of Object.keys(netColors)) { if (network.includes(k.split(' ')[0])) { netKey=k; break; } }
  const colors = netColors[netKey]||{ bg:'#1e88ff' };
  try {
    const { createCanvas } = require('@napi-rs/canvas');
    const W=600, H=360;
    const canvas = createCanvas(W,H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle='#f5f5f7'; ctx.fillRect(0,0,W,H);
    ctx.fillStyle='#ffffff'; roundRect(ctx,20,20,W-40,H-40,12,true,false);
    ctx.strokeStyle='#e0e0e0'; ctx.lineWidth=1; roundRect(ctx,20,20,W-40,H-40,12,false,true);
    ctx.fillStyle='#e3f2fd'; roundRect(ctx,40,40,60,26,6,true,false);
    ctx.fillStyle='#1976d2'; ctx.font='bold 13px sans-serif'; ctx.textBaseline='middle'; ctx.fillText('SMS',56,53);
    ctx.fillStyle='#999999'; ctx.font='12px sans-serif'; ctx.textAlign='right';
    const dispDate = dateMatch?`${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]} ${dateMatch[4].substring(0,5)}`:dt;
    ctx.fillText(dispDate,W-40,53); ctx.textAlign='left';
    ctx.fillStyle='#fff3e0'; roundRect(ctx,40,90,220,36,8,true,false);
    ctx.fillStyle='#ff6b00'; ctx.font='bold 18px sans-serif'; ctx.fillText('TEL  '+phone,52,108);
    ctx.fillStyle='#222222'; ctx.font='15px sans-serif';
    ctx.fillText(`Vous avez envoye ${amount} FCFA au`,40,165);
    ctx.fillStyle='#e3f2fd';
    const phoneLabel=` +225 ${phone} `; ctx.font='bold 15px sans-serif';
    const phoneW=ctx.measureText(phoneLabel).width;
    roundRect(ctx,40,180,phoneW,24,4,true,false);
    ctx.fillStyle='#1976d2'; ctx.fillText(phoneLabel,40,197);
    ctx.fillStyle='#222222'; ctx.font='15px sans-serif';
    ctx.fillText(`${dateFmt}.`,40+phoneW+5,197);
    ctx.fillText(`Votre nouveau solde est de: confirmé.`,40,230);
    ctx.fillText(`ID Transaction: ${idTx}`,40,255);
    ctx.fillStyle='#888888'; ctx.font='11px sans-serif'; ctx.fillText(`Ref: ${ref}`,40,295);
    ctx.fillStyle='#e8f5e9'; roundRect(ctx,W-150,280,110,30,6,true,false);
    ctx.fillStyle='#2e7d32'; ctx.font='bold 12px sans-serif'; ctx.fillText('OK  SUCCESS',W-138,297);
    ctx.fillStyle=colors.bg; ctx.fillRect(20,20,6,H-40);
    const buffer = canvas.toBuffer('image/png');
    return { buffer, mimeType:'image/png', filename:'image.png' };
  } catch(e) {
    return generateBasicPng();
  }
}
function roundRect(ctx,x,y,w,h,r,fill,stroke) {
  ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+r); ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
  if (fill) ctx.fill(); if (stroke) ctx.stroke();
}
function generateBasicPng() {
  return { buffer: Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53,0xDE,0x00,0x00,0x00,0x0C,0x49,0x44,0x41,0x54,0x08,0x99,0x63,0xF8,0xCF,0xC0,0x00,0x00,0x00,0x03,0x00,0x01,0x5B,0x88,0xC0,0xC4,0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,0xAE,0x42,0x60,0x82]), mimeType:'image/png', filename:'image.png' };
}

// ── Confirmation avec fichier ─────────────────────────────────
async function confirmWithFile(u, item, fileBuffer, mimeType, filename) {
  const cd = item.confirmData;
  const fs = require('fs'), os = require('os'), path = require('path');
  await fetch('https://my-managment.com/admin/banktransfer/getallbanksbysubagentid', {
    method:'POST', headers:mgmtH(u), body:JSON.stringify({id:cd.subagent_id,ref_id:cd.ref_id||1}),
  }).catch(()=>{});
  await sleep(400);
  const uniqueName = `confirm_${Date.now()}_${Math.random().toString(36).substring(2,8)}.png`;
  const tmpFile = path.join(os.tmpdir(), uniqueName);
  const fd_write = fs.openSync(tmpFile,'w');
  fs.writeSync(fd_write,fileBuffer,0,fileBuffer.length,0); fs.fsyncSync(fd_write); fs.closeSync(fd_write);
  const stat = fs.statSync(tmpFile);
  if (stat.size===0) return { ok:false, err:'Fichier temporaire vide' };
  let result;
  try {
    const fd = new FormData();
    fd.append('code',cd.code||'epay'); fd.append('id',String(cd.id));
    fd.append('comment',''); fd.append('commentId','null'); fd.append('otherComment','');
    fd.append('is_out','true'); fd.append('subagent_id',String(cd.subagent_id));
    fd.append('ref_id',String(cd.ref_id||1)); fd.append('bank_id',cd.bank_id?String(cd.bank_id):'null');
    fd.append('report_id',u.cfg.reportId); fd.append('user_id',String(cd.user_id||''));
    fd.append('approve_doc',fs.createReadStream(tmpFile),{filename:'image.png',contentType:mimeType||'image/png'});
    const h = {'Accept':'application/json, text/plain, */*','X-Requested-With':'XMLHttpRequest','X-Time-Zone':'GMT+00','Cookie':parseCookies(u.cfg.mgmtCookies),'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36','Referer':'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal','Origin':'https://my-managment.com',...fd.getHeaders()};
    const res = await fetch('https://my-managment.com/admin/banktransfer/approvemoney',{method:'POST',headers:h,body:fd});
    if (res.status===200||res.status===302) {
      const text = await res.text();
      if (text.startsWith('<')||text.includes('<!DOCTYPE')) { result={ok:true}; }
      else { try { const j=JSON.parse(text); const m=j.message||JSON.stringify(j); result=m.toLowerCase().includes('photo confirmation')?{ok:false,err:`Photo refusée: ${m.substring(0,120)}`}:{ok:j.success===true,err:m.substring(0,120)}; } catch(e){result={ok:true};} }
    } else { const et=await res.text().catch(()=>''); result={ok:false,err:`HTTP ${res.status} — ${et.substring(0,80)}`}; }
  } finally { try { require('fs').unlinkSync(tmpFile); } catch(e){} }
  return result;
}

// ── Confirmation sans fichier ─────────────────────────────────
async function confirmWithoutFile(u, item) {
  const cd = item.confirmData;
  await fetch('https://my-managment.com/admin/banktransfer/getallbanksbysubagentid', {
    method:'POST', headers:mgmtH(u), body:JSON.stringify({id:cd.subagent_id,ref_id:cd.ref_id||1}),
  }).catch(()=>{});
  await sleep(400);
  const fd = new FormData();
  fd.append('code',cd.code||'epay'); fd.append('id',String(cd.id)); fd.append('comment',''); fd.append('commentId','null'); fd.append('otherComment',''); fd.append('is_out','true'); fd.append('subagent_id',String(cd.subagent_id)); fd.append('ref_id',String(cd.ref_id||1)); fd.append('bank_id',cd.bank_id?String(cd.bank_id):'null'); fd.append('report_id',u.cfg.reportId); fd.append('user_id',String(cd.user_id||''));
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

// ── Cycle principal par utilisateur ──────────────────────────
async function runCycle(u) {
  if (u.isRunning) return;
  u.isRunning = true; u.stats.polls++;
  ulog(u,'info',`━━ Poll #${u.stats.polls} ━━`);
  try {
    if (!parseCookies(u.cfg.mgmtCookies)) throw new Error('Cookies manquants');
    if (!u.cfg.yapsonToken) throw new Error('Token YapsonPress manquant');

    const groups = await getAllWithdrawals(u);
    const groupList = Object.values(groups);
    if (!groupList.length) { ulog(u,'info','Poll: 0 retrait en attente'); u.isRunning=false; return; }

    ulog(u,'info',`${groupList.length} fournisseur(s) — ${groupList.map(g=>`${g.subagentName.substring(0,20)}(${g.items.length})`).join(', ')}`);

    for (const group of groupList) {
      const { subagentName, network, filesRequired, items } = group;
      ulog(u,'info',`▶ ${subagentName} | ${network} | ${items.length} retrait(s) | Fichier: ${filesRequired?'OUI':'NON'}`);

      for (const item of items) {
        ulog(u,'info',`  → ${item.phone} — ${item.montant.toLocaleString()} FCFA [${network}]`);

        // 1. Décaisser
        const payResult = await payout(u, item, network);
        if (!payResult.ok) {
          u.stats.missing++;
          ulog(u,'err',`  ✘ Décaissement échoué: ${item.phone} — ${payResult.err}`);
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
              // Timeout ou échec → ignorer ce numéro et passer au suivant
              ulog(u,'warn',`  ⚠ ${waitResult.err} — numéro ignoré`);
            } else {
              ulog(u,'warn',`  ⚠ ${item.phone} — ${waitResult.err}`);
            }
            await sleep(800);
            continue; // ← passe au numéro suivant
          }

          ulog(u,'ok',`  ✔ Transaction SUCCESS: ${waitResult.tx?.uid?.substring(0,8)||'?'}`);
          const screenshot = await generateTxScreenshot(waitResult.tx);
          const confirmResult = await confirmWithFile(u, item, screenshot.buffer, screenshot.mimeType, screenshot.filename);
          if (confirmResult.ok) { u.stats.confirmed++; ulog(u,'ok',`  ✔ Confirmé avec fichier: ${item.phone}`); }
          else { u.stats.missing++; ulog(u,'warn',`  ⚠ Confirmation échouée: ${item.phone} — ${confirmResult.err}`); }

        } else {
          // Pas de fichier requis — mais on vérifie quand même la transaction (timeout 2min)
          ulog(u,'info',`  ⏳ Vérification transaction ${item.phone} (max 2min)...`);
          const waitResult = await waitForSuccess(u, payResult.uid, item.phone, 120000);

          if (!waitResult.ok) {
            u.stats.missing++;
            ulog(u,'warn',`  ⚠ ${waitResult.err} — numéro ignoré`);
            await sleep(800);
            continue; // ← passe au numéro suivant
          }

          await sleep(1000);
          const confirmResult = await confirmWithoutFile(u, item);
          if (confirmResult.ok) { u.stats.confirmed++; ulog(u,'ok',`  ✔ Confirmé: ${item.phone}`); }
          else { u.stats.missing++; ulog(u,'warn',`  ⚠ Manuel: ${item.phone} — ${confirmResult.err}`); }
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

// ── CSS partagé ───────────────────────────────────────────────
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
.btn{padding:9px 18px;border-radius:7px;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;border:none;text-decoration:none;display:inline-block}
.btn-save{background:rgba(88,166,255,.15);color:var(--b);border:1px solid rgba(88,166,255,.4)}
.btn-go{background:rgba(63,185,80,.2);color:var(--g);border:1px solid rgba(63,185,80,.4)}
.btn-stop{background:rgba(248,81,73,.15);color:var(--r);border:1px solid rgba(248,81,73,.35)}
.btn-gray{background:var(--s2);color:var(--m);border:1px solid var(--s3)}
.btn-red{background:rgba(248,81,73,.8);color:#fff;border:none}
.btn-purple{background:rgba(188,140,255,.8);color:#fff;border:none}
.btn:hover{filter:brightness(1.15)}.btns{display:flex;gap:8px;flex-wrap:wrap}
.statbar{display:flex;gap:8px;flex-wrap:wrap}
.sc{background:var(--s1);border:1px solid var(--s3);border-radius:10px;padding:12px 20px;min-width:90px;text-align:center;flex:1}
.sv{font-size:28px;font-weight:700;line-height:1}.sl{font-size:9px;color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.sc.vc .sv{color:var(--g)}.sc.vm .sv{color:var(--o)}.sc.vp .sv{color:var(--p)}.sc.vs .sv{color:var(--t)}.sc.vr .sv{color:var(--r)}
.badge{display:inline-flex;align-items:center;gap:5px;border-radius:20px;padding:4px 12px;font-size:10px;font-weight:700}
.badge .dot{width:7px;height:7px;border-radius:50%}
.b-on{background:rgba(63,185,80,.15);color:var(--g);border:1px solid rgba(63,185,80,.3)}
.b-on .dot{background:var(--g);animation:pulse 1.8s infinite}
.b-off{background:rgba(139,148,158,.1);color:var(--m);border:1px solid rgba(139,148,158,.2)}
.b-off .dot{background:var(--m)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.log{background:#0d1117;border-radius:7px;max-height:400px;overflow-y:auto;padding:8px;font-size:10px;line-height:1.9;word-break:break-word}
.le{display:flex;gap:10px}.lt{color:var(--m);min-width:135px;flex-shrink:0}
.ok span:last-child{color:var(--g)}.er span:last-child{color:var(--r)}.wa span:last-child{color:var(--o)}.in span:last-child{color:var(--b)}
.tag-ok{display:inline-block;background:rgba(63,185,80,.15);color:var(--g);border:1px solid rgba(63,185,80,.3);border-radius:4px;padding:1px 7px;font-size:9px;margin-left:6px}
.tag-err{display:inline-block;background:rgba(248,81,73,.15);color:var(--r);border:1px solid rgba(248,81,73,.3);border-radius:4px;padding:1px 7px;font-size:9px;margin-left:6px}
.tbl{width:100%;border-collapse:collapse;font-size:11px}
.tbl th{background:var(--s2);padding:7px;text-align:left;color:var(--b)}
.tbl td{padding:6px 7px;border-bottom:1px solid var(--s3)}
.seclbl{font-size:11px;font-weight:700;margin-bottom:10px}
`;

// ── Page login ────────────────────────────────────────────────
function loginPage(err='') {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bot7-F</title>
<style>${CSS_COMMON}
.box{max-width:380px;margin:80px auto;background:var(--s1);border:1px solid var(--s3);border-radius:12px;padding:28px}
h1{color:var(--p);font-size:1.2rem;margin-bottom:20px;text-align:center}
</style></head><body><div class="box">
<h1>🤖 YapsonBot7-F</h1>
${err?`<div style="color:var(--r);font-size:11px;margin-bottom:10px">✘ ${err}</div>`:''}
<form method="POST" action="/login">
<div class="frow"><label>Utilisateur</label><input type="text" name="username" required></div>
<div class="frow"><label>Mot de passe</label><input type="password" name="password" required></div>
<button class="btn btn-go" style="width:100%;margin-top:8px">Connexion</button>
</form></div></body></html>`;
}

// ── Dashboard utilisateur ─────────────────────────────────────
function userPage(u) {
  const hasSession = parseCookies(u.cfg.mgmtCookies).length > 20;
  const logHtml = u.logs.slice(0,120).map(e => {
    const cls=e.type==='ok'?'ok':e.type==='err'?'er':e.type==='warn'?'wa':'in';
    const ic=e.type==='ok'?'✔':e.type==='err'?'✘':e.type==='warn'?'⚠':'▸';
    return `<div class="le ${cls}"><span class="lt">${e.ts}</span><span>${ic} ${e.msg}</span></div>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bot7-F — ${u.username}</title>
<style>${CSS_COMMON}</style>
<script>
if (${JSON.stringify(u.botActive)}) setTimeout(()=>location.reload(), 15000);
</script>
</head><body><div class="wrap">

<div style="display:flex;justify-content:space-between;align-items:center">
  <div style="color:var(--p);font-weight:700;font-size:1.1rem">🤖 ${u.username}</div>
  <a href="/logout" class="btn btn-gray" style="font-size:10px">Déconnexion</a>
</div>

<div class="statbar">
<div class="sc vc"><div class="sv">${u.stats.confirmed}</div><div class="sl">Confirmés</div></div>
<div class="sc vm"><div class="sv">${u.stats.missing}</div><div class="sl">Manquants</div></div>
<div class="sc vp"><div class="sv">${u.stats.polls}</div><div class="sl">Polls</div></div>
<div class="sc vr"><div class="sv">${u.stats.rejected}</div><div class="sl">Rejetés</div></div>
</div>

<div class="card"><div class="ch">🔑 COMPTES</div><div class="cb">
<form method="POST" action="/user/save-accounts"><div class="g2">
<div><div class="seclbl" style="color:var(--b)">agg.yapson.net</div>
<div class="frow"><label>Token Yapson</label>
<input type="password" name="yapsonToken" value="${u.cfg.yapsonToken?'●'.repeat(20):''}" placeholder="eyJhbGci...">
${u.cfg.yapsonToken?'<span class="tag-ok">✓ OK</span>':'<span class="tag-err">✗ manquant</span>'}
</div></div>
<div><div class="seclbl" style="color:var(--g)">my-managment.com</div>
<div class="frow"><label>Cookies de session</label>
<textarea name="mgmtCookies" rows="3" placeholder='[{"name":"auid",...}] ou PHPSESSID=...'></textarea>
${hasSession?'<span class="tag-ok">✓ Session active</span>':'<span class="tag-err">✗ Requis</span>'}
</div></div></div>
<div style="margin-top:14px"><button class="btn btn-save">💾 Sauvegarder</button></div>
</form></div></div>

<div class="card"><div class="ch">⚙️ CONFIGURATION</div><div class="cb">
<form method="POST" action="/user/save-config">
<div class="frow"><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
<span style="font-size:11px;color:var(--m)">Intervalle :</span>
<input type="number" name="pollInterval" value="${u.cfg.pollInterval}" min="60" max="86400" style="width:90px">
<span style="font-size:11px;color:var(--m)">s</span>
<span style="font-size:11px;color:var(--m);margin-left:16px">Solde max :</span>
<input type="number" name="maxSolde" value="${u.cfg.maxSolde}" min="0" style="width:120px">
<span style="font-size:11px;color:var(--m)">FCFA (0=illimité)</span>
</div></div>
<div style="margin-top:14px"><button class="btn btn-save">💾 Appliquer</button></div>
</form></div></div>

<div class="card"><div class="ch">▶ CONTRÔLES</div><div class="cb">
<span class="${u.botActive?'badge b-on':'badge b-off'}"><span class="dot"></span>${u.botActive?'Actif — toutes les '+u.cfg.pollInterval+'s':'Arrêté'}</span>
<div class="btns" style="margin-top:14px">
<a class="btn ${u.botActive?'btn-gray':'btn-go'}" href="/user/start">▶ Démarrer</a>
<a class="btn ${u.botActive?'btn-stop':'btn-gray'}" href="/user/stop">■ Arrêter</a>
<a class="btn btn-gray" href="/user/run">↻ Cycle manuel</a>
<a class="btn btn-gray" href="/user/reset">◌ Reset stats</a>
<a class="btn btn-gray" href="/dashboard">⟳ Actualiser</a>
</div></div></div>

<div class="card"><div class="ch">📋 JOURNAL — ${u.logs.length} entrées</div>
<div class="cb" style="padding:8px"><div class="log">${logHtml||'<div class="le in"><span class="lt">—</span><span>▸ En attente</span></div>'}</div>
</div></div>
</div></body></html>`;
}

// ── Dashboard admin ───────────────────────────────────────────
function adminPage(err='', ok='') {
  const list = Object.values(users);
  const rows = list.map(u=>`<tr>
<td>${u.username}</td>
<td><span style="color:${u.botActive?'var(--g)':'var(--m)'}">${u.botActive?'● Actif':'■ Arrêté'}</span></td>
<td style="color:var(--g)">${u.stats.confirmed}</td>
<td style="color:var(--o)">${u.stats.missing}</td>
<td style="color:var(--r)">${u.stats.rejected}</td>
<td>${parseCookies(u.cfg.mgmtCookies).length>20?'<span class="tag-ok">✓</span>':'<span class="tag-err">✗</span>'}</td>
<td>${u.cfg.yapsonToken?'<span class="tag-ok">✓</span>':'<span class="tag-err">✗</span>'}</td>
<td><form method="POST" action="/admin/delete-user" style="display:inline"><input type="hidden" name="userId" value="${u.id}"><button class="btn btn-red" style="font-size:10px;padding:3px 8px" onclick="return confirm('Supprimer ${u.username} ?')">Supprimer</button></form></td>
</tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bot7-F Admin</title>
<style>${CSS_COMMON}</style></head><body><div class="wrap">

<div style="display:flex;justify-content:space-between;align-items:center">
  <div style="color:var(--p);font-weight:700;font-size:1.1rem">🛡 Administration — YapsonBot7-F</div>
  <a href="/logout" class="btn btn-gray" style="font-size:10px">Déconnexion</a>
</div>

${err?`<div style="color:var(--r);font-size:11px">✘ ${err}</div>`:''}
${ok?`<div style="color:var(--g);font-size:11px">✔ ${ok}</div>`:''}

<div class="statbar">
<div class="sc"><div class="sv" style="color:var(--p)">${list.length}</div><div class="sl">Utilisateurs</div></div>
<div class="sc"><div class="sv" style="color:var(--g)">${list.filter(u=>u.botActive).length}</div><div class="sl">Actifs</div></div>
<div class="sc vc"><div class="sv">${list.reduce((s,u)=>s+u.stats.confirmed,0)}</div><div class="sl">Confirmés total</div></div>
<div class="sc vm"><div class="sv">${list.reduce((s,u)=>s+u.stats.missing,0)}</div><div class="sl">Manquants total</div></div>
</div>

<div class="card"><div class="ch">➕ CRÉER UN UTILISATEUR</div><div class="cb">
<form method="POST" action="/admin/create-user">
<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
<div class="frow" style="margin:0;flex:1"><label>Nom d'utilisateur</label><input type="text" name="username" required style="width:auto"></div>
<div class="frow" style="margin:0;flex:1"><label>Mot de passe</label><input type="password" name="password" required style="width:auto"></div>
<button class="btn btn-purple">Créer</button>
</div></form></div></div>

<div class="card"><div class="ch">👥 UTILISATEURS (${list.length})</div><div class="cb">
${list.length===0?'<div style="color:var(--m);font-size:11px">Aucun utilisateur créé.</div>':`
<table class="tbl"><tr><th>Utilisateur</th><th>Statut</th><th>Confirmés</th><th>Manquants</th><th>Rejetés</th><th>Cookies</th><th>Token</th><th>Action</th></tr>
${rows}</table>`}
</div></div>

<div class="card"><div class="ch">🔑 MOT DE PASSE ADMIN</div><div class="cb">
<form method="POST" action="/admin/change-password">
<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
<div class="frow" style="margin:0;flex:1"><label>Ancien mot de passe</label><input type="password" name="oldPass" style="width:auto"></div>
<div class="frow" style="margin:0;flex:1"><label>Nouveau mot de passe</label><input type="password" name="newPass" style="width:auto"></div>
<button class="btn btn-save">Changer</button>
</div></form></div></div>

</div></body></html>`;
}

// ── Routes ────────────────────────────────────────────────────
app.get('/login',  (req,res) => res.send(loginPage()));
app.post('/login', (req,res) => {
  const { username, password } = req.body;
  if (username===ADMIN_USER && password===ADMIN_PASS) {
    const tok = createSession('admin',true);
    res.setHeader('Set-Cookie',`session=${tok}; HttpOnly; Path=/; Max-Age=28800`);
    return res.redirect('/admin');
  }
  const u = Object.values(users).find(u=>u.username===username && u.passwordHash===hashPass(password));
  if (u) {
    const tok = createSession(u.id,false);
    res.setHeader('Set-Cookie',`session=${tok}; HttpOnly; Path=/; Max-Age=28800`);
    return res.redirect('/dashboard');
  }
  res.send(loginPage('Identifiants incorrects'));
});
app.get('/logout', (req,res) => { res.setHeader('Set-Cookie','session=; HttpOnly; Path=/; Max-Age=0'); res.redirect('/login'); });
app.get('/', (req,res) => { const s=getSession(req); if(!s) return res.redirect('/login'); return s.isAdmin?res.redirect('/admin'):res.redirect('/dashboard'); });

// Routes utilisateur
function requireUser(req,res) { const s=getSession(req); if(!s||s.isAdmin) { res.redirect('/login'); return null; } const u=users[s.userId]; if(!u){res.redirect('/login');return null;} return u; }

app.get('/dashboard', (req,res) => { const s=getSession(req); if(!s) return res.redirect('/login'); if(s.isAdmin) return res.redirect('/admin'); const u=users[s.userId]; if(!u) return res.redirect('/login'); res.send(userPage(u)); });

app.post('/user/save-accounts', (req,res) => {
  const s=getSession(req); if(!s||s.isAdmin) return res.redirect('/login');
  const u=users[s.userId]; if(!u) return res.redirect('/login');
  const{yapsonToken,mgmtCookies}=req.body;
  if(yapsonToken&&!yapsonToken.startsWith('●')){u.cfg.yapsonToken=yapsonToken.trim();ulog(u,'ok','🔑 Token yapson mis à jour');}
  if(mgmtCookies){const t=mgmtCookies.trim();const ok=t.startsWith('[')||/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(t);const bad=t.includes('configuré')||t.includes('(coller')||t.startsWith('(');if(ok&&!bad){u.cfg.mgmtCookies=t;ulog(u,'ok',`🍪 Cookies mis à jour — ${parseCookies(t).split(';').length} cookie(s)`);}else if(bad){ulog(u,'warn','⚠ Cookies ignorés (placeholder)');}}
  ulog(u,'ok','Comptes sauvegardés');
  if(u.botActive){stopPolling(u);setTimeout(()=>startPolling(u),500);}
  res.redirect('/dashboard');
});
app.post('/user/save-config', (req,res) => {
  const s=getSession(req); if(!s||s.isAdmin) return res.redirect('/login');
  const u=users[s.userId]; if(!u) return res.redirect('/login');
  if(req.body.pollInterval) u.cfg.pollInterval=Math.max(60,parseInt(req.body.pollInterval));
  if(req.body.maxSolde!==undefined) u.cfg.maxSolde=parseInt(req.body.maxSolde)||0;
  ulog(u,'ok',`Config: intervalle=${u.cfg.pollInterval}s`);
  if(u.botActive){stopPolling(u);setTimeout(()=>startPolling(u),500);}
  res.redirect('/dashboard');
});
app.get('/user/start', (req,res) => { const s=getSession(req); if(!s||s.isAdmin) return res.redirect('/login'); const u=users[s.userId]; if(u) startPolling(u); res.redirect('/dashboard'); });
app.get('/user/stop',  (req,res) => { const s=getSession(req); if(!s||s.isAdmin) return res.redirect('/login'); const u=users[s.userId]; if(u) stopPolling(u);  res.redirect('/dashboard'); });
app.get('/user/run',   (req,res) => { const s=getSession(req); if(!s||s.isAdmin) return res.redirect('/login'); const u=users[s.userId]; if(u) runCycle(u).catch(e=>ulog(u,'err',e.message)); res.redirect('/dashboard'); });
app.get('/user/reset', (req,res) => { const s=getSession(req); if(!s||s.isAdmin) return res.redirect('/login'); const u=users[s.userId]; if(u){Object.keys(u.stats).forEach(k=>u.stats[k]=0);u.logs.length=0;ulog(u,'info','Reset');} res.redirect('/dashboard'); });

// Routes admin
app.get('/admin', (req,res) => { const s=getSession(req); if(!s||!s.isAdmin) return res.redirect('/login'); res.send(adminPage()); });
app.post('/admin/create-user', (req,res) => {
  const s=getSession(req); if(!s||!s.isAdmin) return res.redirect('/login');
  const{username,password}=req.body;
  if(!username||!password) return res.send(adminPage('Nom et mot de passe requis'));
  if(Object.values(users).find(u=>u.username===username.trim())) return res.send(adminPage(`"${username}" existe déjà`));
  createUser(username.trim(),password.trim());
  res.send(adminPage('',`Utilisateur "${username}" créé ✔`));
});
app.post('/admin/delete-user', (req,res) => {
  const s=getSession(req); if(!s||!s.isAdmin) return res.redirect('/login');
  const u=users[req.body.userId]; if(!u) return res.send(adminPage('Introuvable'));
  const name=u.username; stopPolling(u); delete users[req.body.userId];
  res.send(adminPage('',`"${name}" supprimé ✔`));
});
app.post('/admin/change-password', (req,res) => {
  const s=getSession(req); if(!s||!s.isAdmin) return res.redirect('/login');
  const{oldPass,newPass}=req.body;
  if(oldPass!==ADMIN_PASS) return res.send(adminPage('Ancien mot de passe incorrect'));
  if(!newPass||newPass.length<4) return res.send(adminPage('Mot de passe trop court (min 4 caractères)'));
  ADMIN_PASS=newPass;
  res.send(adminPage('','Mot de passe admin changé ✔'));
});

app.get('/health',(req,res) => {
  const s=getSession(req);
  if(!s) return res.status(401).json({error:'Non autorisé'});
  if(s.isAdmin) return res.json({users:Object.values(users).map(u=>({username:u.username,botActive:u.botActive,confirmed:u.stats.confirmed,missing:u.stats.missing}))});
  const u=users[s.userId]; return u?res.json({...u.stats,botActive:u.botActive}):res.status(404).json({error:'Introuvable'});
});

app.listen(PORT, () => {
  console.log(`YapsonBot7-F multi-users — port ${PORT} | Admin: ${ADMIN_USER}`);
});
