// Presso Center — e-mails via Resend (fonction Edge Supabase « mail »)
//
//   POST /mail/inbound   webhook Resend « email.received » : enregistre chaque message
//                        reçu sur @pressocenter.fr dans la table messages (messagerie
//                        de l'espace de gestion) et en envoie une copie à NOTIFY_TO.
//   POST /mail/send      envoi d'un message depuis l'espace de gestion, au nom de
//                        contact@pressocenter.fr. Réservé au compte gérant.
//   POST /mail/notify    appelé par les déclencheurs de la base (voir supabase/mail.sql) :
//                        nouvelle réservation, réservation confirmée, demande de club.
//
// Secrets de la fonction : RESEND_API_KEY, RESEND_WEBHOOK_SECRET, HOOK_SECRET,
// NOTIFY_TO, MAIL_FROM, SITE_URL. Aucun secret dans ce fichier.

const RESEND = 'https://api.resend.com';
const env = (k: string) => Deno.env.get(k) ?? '';
const SITE = () => env('SITE_URL') || 'https://pressocenter.fr';
const FROM = () => env('MAIL_FROM') || 'Presso Center <contact@pressocenter.fr>';
const FROM_ADDRESS = () => (FROM().match(/<([^>]+)>/)?.[1] ?? FROM()).trim();
const MAX_ATTACHMENTS_BYTES = 15 * 1024 * 1024;

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });

// Seul le site peut appeler /send depuis un navigateur
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = [SITE(), SITE().replace('://', '://www.')];
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : SITE(),
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

// ---------------------------------------------------------------- Base (clé de service, côté serveur uniquement)
async function db(path: string, opts: { method?: string; body?: unknown; prefer?: string } = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(`${env('SUPABASE_URL')}/rest/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.prefer ? { Prefer: opts.prefer } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Base ${res.status} sur ${path} : ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function isAdmin(authorization: string) {
  if (!/^Bearer\s+\S+/i.test(authorization)) return false;
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: authorization },
  });
  if (!res.ok) return false;
  const user = await res.json();
  if (!user?.id) return false;
  const rows = await db(`/admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`);
  return Array.isArray(rows) && rows.length === 1;
}

const htmlToText = (h: string) =>
  h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ---------------------------------------------------------------- Resend
async function resend(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env('RESEND_API_KEY')}`,
    'Content-Type': 'application/json',
  };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey.slice(0, 256);
  const res = await fetch(RESEND + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`Resend ${res.status} sur ${path} : ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

const sendEmail = (payload: Record<string, unknown>, idempotencyKey: string) =>
  resend('/emails', { method: 'POST', body: payload, idempotencyKey });

// ---------------------------------------------------------------- Mise en forme
const dateFr = (iso: string) =>
  new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
const timeFr = (iso: string) =>
  new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(':', 'h');
const eur = (n: unknown) => {
  const v = Number(n) || 0;
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(v);
};
const duration = (min: unknown) => {
  const m = Number(min) || 0;
  const h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ' ' + String(m % 60).padStart(2, '0') : ''}` : `${m} min`;
};
const firstName = (name: unknown) => String(name ?? '').trim().split(/\s+/)[0] || '';

function layout(title: string, intro: string, rows: [string, string][], cta?: { label: string; url: string }, outro = '') {
  const table = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:8px 0;color:#626977;font-size:14px;width:38%;vertical-align:top">${esc(k)}</td><td style="padding:8px 0;color:#0f1623;font-size:15px;font-weight:600">${v}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#f6f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f1623">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ef"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="background:#0f1623;border-radius:16px 16px 0 0;padding:20px 28px;color:#c4a062;font-size:12px;font-weight:800;letter-spacing:.22em">PRESSO CENTER</td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 16px 16px;padding:28px">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;color:#0f1623">${esc(title)}</h1>
<p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#464d5b">${intro}</p>
${table ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e2ddd2;border-bottom:1px solid #e2ddd2;margin:0 0 20px">${table}</table>` : ''}
${cta ? `<p style="margin:0 0 20px"><a href="${esc(cta.url)}" style="display:inline-block;background:#c4a062;color:#0f1623;text-decoration:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:999px">${esc(cta.label)}</a></p>` : ''}
${outro ? `<p style="margin:0;font-size:14px;line-height:1.55;color:#626977">${outro}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 8px;text-align:center;font-size:12px;color:#626977">Presso Center · Récupération sportive mobile · Tours · <a href="${esc(SITE())}" style="color:#626977">${esc(SITE().replace(/^https?:\/\//, ''))}</a></td></tr>
</table></td></tr></table></body></html>`;
}

const textOf = (title: string, intro: string, rows: [string, string][], outro = '') =>
  [title, '', intro.replace(/<[^>]+>/g, ''), '', ...rows.filter(([, v]) => v).map(([k, v]) => `${k} : ${v.replace(/<[^>]+>/g, '')}`), '', outro.replace(/<[^>]+>/g, ''), '', 'Presso Center · ' + SITE()]
    .join('\n');

// ---------------------------------------------------------------- Notifications
type Row = Record<string, any>;

function bookingRows(b: Row, forOwner: boolean): [string, string][] {
  const formule = `${esc(b.service_name || b.service || 'Séance')}${Number(b.people) > 1 ? ' × ' + esc(b.people) : ''}`;
  const where = b.kind === 'domicile' ? esc(b.address || 'À domicile') : esc(b.location || b.base_location || '');
  const rows: [string, string][] = [
    ['Formule', formule],
    ['Date', `${esc(dateFr(b.start_at))} à ${esc(timeFr(b.start_at))}`],
    ['Durée', esc(duration(b.duration_min))],
    ['Lieu', where],
    ['Prix', `${esc(eur(b.price))}${b.payment_mode === 'credit' ? ' (carte ou abonnement)' : ' à régler sur place'}`],
    ['Référence', esc(b.ref || '')],
  ];
  if (forOwner) {
    rows.unshift(['Client', esc(b.client_name || '')]);
    rows.push(['Téléphone', b.client_phone ? `<a href="tel:${esc(b.client_phone)}" style="color:#0f1623">${esc(b.client_phone)}</a>` : '']);
    rows.push(['E-mail', esc(b.client_email || '')]);
    rows.push(['Mineur', b.is_minor ? `Oui, autorisation de ${esc(b.guardian_name || '?')}` : '']);
    rows.push(['Message', esc(b.notes || '')]);
  }
  return rows;
}

async function notify(kind: string, r: Row) {
  const owner = env('NOTIFY_TO');
  const sent: string[] = [];

  if (kind === 'booking_new') {
    const when = `${dateFr(r.start_at)} à ${timeFr(r.start_at)}`;
    if (owner) {
      const title = 'Nouvelle demande de réservation';
      const intro = `${esc(r.client_name || 'Un client')} demande une séance le <b>${esc(when)}</b>. Elle attend ta confirmation dans l'agenda.`;
      const rows = bookingRows(r, true);
      await sendEmail({
        from: FROM(), to: [owner], subject: `Nouvelle demande : ${r.service_name || 'séance'} · ${when} · ${r.client_name || ''}`.trim(),
        html: layout(title, intro, rows, { label: "Ouvrir l'agenda", url: `${SITE()}/gestion.html#agenda` }),
        text: textOf(title, intro, rows, `${SITE()}/gestion.html#agenda`),
        ...(r.client_email ? { reply_to: r.client_email } : {}),
      }, `booking-new/${r.id}`);
      sent.push('owner');
    }
    if (r.client_email) {
      const title = 'Ta demande est bien reçue';
      const intro = `Bonjour ${esc(firstName(r.client_name))}, on a bien reçu ta demande de séance. On te confirme le créneau par message très vite.`;
      const rows = bookingRows(r, false);
      const outro = "Un empêchement ? Réponds simplement à cet e-mail, au moins 12 h avant la séance.";
      await sendEmail({
        from: FROM(), to: [r.client_email], reply_to: FROM_ADDRESS(), subject: 'Ta demande de séance est bien reçue',
        html: layout(title, intro, rows, undefined, outro), text: textOf(title, intro, rows, outro),
      }, `booking-ack/${r.id}`);
      sent.push('client');
    }
  } else if (kind === 'booking_confirmed') {
    if (r.client_email) {
      const title = 'Ta séance est confirmée';
      const intro = `Bonjour ${esc(firstName(r.client_name))}, ta séance du <b>${esc(dateFr(r.start_at))} à ${esc(timeFr(r.start_at))}</b> est confirmée. À bientôt !`;
      const rows = bookingRows(r, false);
      const outro = "Prévois une tenue confortable. Un empêchement ? Réponds à cet e-mail, au moins 12 h avant la séance.";
      await sendEmail({
        from: FROM(), to: [r.client_email], reply_to: FROM_ADDRESS(), subject: `Séance confirmée : ${dateFr(r.start_at)} à ${timeFr(r.start_at)}`,
        html: layout(title, intro, rows, undefined, outro), text: textOf(title, intro, rows, outro),
      }, `booking-confirmed/${r.id}/${new Date(r.start_at).getTime()}`);
      sent.push('client');
    }
  } else if (kind === 'club_request') {
    if (owner) {
      const title = 'Nouvelle demande de test pilote';
      const intro = `<b>${esc(r.name || 'Un club')}</b> souhaite organiser un test pilote.`;
      const rows: [string, string][] = [
        ['Structure', esc(r.name || '')], ['Type', esc(r.kind || '')], ['Sport', esc(r.sport || '')], ['Contact', esc(r.contact_name || '')],
        ['Téléphone', r.phone ? `<a href="tel:${esc(r.phone)}" style="color:#0f1623">${esc(r.phone)}</a>` : ''], ['E-mail', esc(r.email || '')],
        ['Formule envisagée', esc(r.plan || '')], ['Message', esc(r.notes || '')],
      ];
      await sendEmail({
        from: FROM(), to: [owner], subject: `Demande de test pilote : ${r.name || ''}`.trim(),
        html: layout(title, intro, rows, { label: 'Ouvrir les partenaires', url: `${SITE()}/gestion.html#clients` }),
        text: textOf(title, intro, rows, `${SITE()}/gestion.html#clients`),
        ...(r.email ? { reply_to: r.email } : {}),
      }, `club-request/${r.id}`);
      sent.push('owner');
    }
  } else {
    throw new Error(`Type d'événement inconnu : ${kind}`);
  }
  return sent;
}

// ---------------------------------------------------------------- Réception
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function verifySvix(payload: string, h: Headers, secret: string) {
  const id = h.get('svix-id'), ts = h.get('svix-timestamp'), sig = h.get('svix-signature');
  if (!id || !ts || !sig || !secret) return false;
  if (!Number.isFinite(Number(ts)) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${payload}`)));
  const expected = btoa(String.fromCharCode(...mac));
  return sig.split(' ').some((part) => {
    const [version, value] = part.split(',');
    return version === 'v1' && !!value && safeEqual(value, expected);
  });
}

function parseAddress(v: unknown) {
  const s = String(v ?? '').trim();
  const m = s.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: '', email: s };
}

function toBase64(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function forwardInbound(emailId: string) {
  const owner = env('NOTIFY_TO');
  if (!owner) throw new Error('NOTIFY_TO manquant');
  const mail = await resend(`/emails/receiving/${emailId}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(mail.headers ?? {})) headers[k.toLowerCase()] = String(v);
  if (headers['x-presso-forwarded']) return 'déjà transféré';

  const sender = parseAddress(mail.from);
  const replyTo = Array.isArray(mail.reply_to) && mail.reply_to.length ? mail.reply_to : [sender.email];
  const to = (Array.isArray(mail.to) ? mail.to : [mail.to]).filter(Boolean).join(', ');

  // Messagerie de l'espace de gestion : texte seul, jamais de HTML reçu de l'extérieur
  await db('/messages?on_conflict=resend_id', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=minimal',
    body: {
      direction: 'in',
      from_name: sender.name.slice(0, 200) || null,
      from_email: String(replyTo[0] || sender.email).slice(0, 320),
      to_email: to.slice(0, 500),
      subject: String(mail.subject || '(sans objet)').slice(0, 500),
      body: String(mail.text || (mail.html ? htmlToText(String(mail.html)) : '')).slice(0, 100000),
      attachments: (Array.isArray(mail.attachments) ? mail.attachments : []).map((a: any) => ({ filename: String(a.filename || 'pièce jointe').slice(0, 200), size: Number(a.size) || 0 })),
      resend_id: emailId,
      message_id: mail.message_id ? String(mail.message_id).slice(0, 500) : null,
    },
  });

  // Pièces jointes, dans la limite de taille acceptée
  const attachments: { filename: string; content: string }[] = [];
  const skipped: string[] = [];
  if (Array.isArray(mail.attachments) && mail.attachments.length) {
    const list = await resend(`/emails/receiving/${emailId}/attachments`);
    let total = 0;
    for (const a of list?.data ?? []) {
      const size = Number(a.size) || 0;
      if (!a.download_url || total + size > MAX_ATTACHMENTS_BYTES) {
        skipped.push(a.filename || 'pièce jointe');
        continue;
      }
      const res = await fetch(a.download_url);
      if (!res.ok) {
        skipped.push(a.filename || 'pièce jointe');
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      total += bytes.length;
      attachments.push({ filename: a.filename || 'piece-jointe', content: toBase64(bytes) });
    }
  }

  const who = sender.name ? `${sender.name} <${sender.email}>` : sender.email;
  const banner = `<div style="margin:0 0 16px;padding:12px 14px;border-left:3px solid #c4a062;background:#f6f4ef;font:14px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#464d5b">Message reçu sur <b>${esc(to)}</b> de <b>${esc(who)}</b>. Réponds à cet e-mail pour lui écrire directement.${skipped.length ? `<br>Pièces jointes non transférées (trop lourdes) : ${esc(skipped.join(', '))}.` : ''}</div>`;
  const body = mail.html ? String(mail.html) : `<pre style="white-space:pre-wrap;font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif">${esc(mail.text || '')}</pre>`;
  const display = (sender.name || sender.email).replace(/["<>\r\n]/g, '').slice(0, 60);

  await sendEmail({
    from: `${display} via Presso Center <${FROM_ADDRESS()}>`,
    to: [owner],
    reply_to: replyTo,
    subject: mail.subject || '(sans objet)',
    html: banner + body,
    text: `Message reçu sur ${to} de ${who}.\n\n${mail.text || ''}`,
    headers: { 'X-Presso-Forwarded': '1' },
    ...(attachments.length ? { attachments } : {}),
  }, `inbound-forward/${emailId}`);
  return 'transféré';
}

// ---------------------------------------------------------------- Envoi depuis l'espace de gestion
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;

async function sendFromApp(p: Record<string, any>) {
  const to = String(p.to ?? '').trim();
  const subject = String(p.subject ?? '').trim();
  const body = String(p.body ?? '').trim();
  const id = String(p.id ?? '');
  if (!EMAIL_RE.test(to) || to.length > 320) throw new Error('Adresse du destinataire invalide.');
  if (!subject || subject.length > 300) throw new Error("L'objet est obligatoire (300 caractères maximum).");
  if (!body || body.length > 20000) throw new Error('Le message est vide ou trop long.');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Identifiant du message manquant.');

  let replyToId: string | null = null;
  const headers: Record<string, string> = {};
  if (p.reply_to_id && /^[0-9a-f-]{36}$/i.test(String(p.reply_to_id))) {
    const rows = await db(`/messages?id=eq.${p.reply_to_id}&select=id,message_id`);
    if (rows?.[0]) {
      replyToId = rows[0].id;
      if (rows[0].message_id) {
        headers['In-Reply-To'] = rows[0].message_id;
        headers['References'] = rows[0].message_id;
      }
    }
  }

  const html = `<div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f1623">${esc(body).replace(/\n/g, '<br>')}</div>` +
    `<p style="margin-top:24px;padding-top:12px;border-top:1px solid #e2ddd2;font:13px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#626977"><b style="color:#0f1623">Presso Center</b><br>Récupération sportive mobile · Tours<br><a href="${esc(SITE())}" style="color:#626977">${esc(SITE().replace(/^https?:\/\//, ''))}</a></p>`;
  const sent = await sendEmail({
    from: FROM(), to: [to], reply_to: FROM_ADDRESS(), subject,
    text: `${body}\n\n--\nPresso Center · ${SITE()}`, html,
    ...(Object.keys(headers).length ? { headers } : {}),
  }, `app-send/${id}`);

  const rows = await db('/messages?on_conflict=id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: { id, direction: 'out', from_name: 'Presso Center', from_email: FROM_ADDRESS(), to_email: to, subject, body, resend_id: sent?.id ?? null, reply_to_id: replyToId, read: true },
  });
  return rows?.[0] ?? null;
}

// ---------------------------------------------------------------- Entrée
Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  if (path.endsWith('/send') && req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);

  try {
    if (path.endsWith('/send')) {
      if (!(await isAdmin(req.headers.get('authorization') ?? ''))) return json({ error: 'Non autorisé' }, 401, cors(req));
      try {
        return json({ ok: true, message: await sendFromApp(await req.json()) }, 200, cors(req));
      } catch (e) {
        console.error(e);
        return json({ error: e instanceof Error ? e.message : String(e) }, 400, cors(req));
      }
    }

    if (path.endsWith('/notify')) {
      const secret = env('HOOK_SECRET');
      if (!secret || !safeEqual(req.headers.get('x-hook-secret') ?? '', secret)) return json({ error: 'Non autorisé' }, 401);
      const { kind, record } = await req.json();
      if (!kind || !record) return json({ error: 'Requête incomplète' }, 400);
      return json({ ok: true, sent: await notify(String(kind), record) });
    }

    if (path.endsWith('/inbound')) {
      const payload = await req.text();
      if (!(await verifySvix(payload, req.headers, env('RESEND_WEBHOOK_SECRET')))) return json({ error: 'Signature invalide' }, 401);
      const event = JSON.parse(payload);
      if (event?.type !== 'email.received' || !event?.data?.email_id) return json({ ok: true, ignored: event?.type ?? null });
      return json({ ok: true, result: await forwardInbound(String(event.data.email_id)) });
    }

    return json({ error: 'Introuvable' }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
