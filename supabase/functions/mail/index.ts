// Presso Center — e-mails via Resend (fonction Edge Supabase « mail »)
//
//   POST /mail/inbound   webhook Resend « email.received » : enregistre chaque message
//                        reçu sur @pressocenter.fr dans la table messages (messagerie
//                        de l'espace de gestion) et en envoie une copie à NOTIFY_TO.
//                        Les messages des autres domaines du compte Resend sont ignorés.
//   POST /mail/send      envoi d'un message depuis l'espace de gestion, au nom de
//                        contact@pressocenter.fr. Réservé au compte gérant.
//   POST /mail/notify    appelé par les déclencheurs de la base (voir supabase/mail.sql) :
//                        nouvelle réservation, réservation confirmée, demande de club.
//   POST /mail/newsletter  envoi de la newsletter aux abonnés (ou d'un test au
//                        gérant). Réservé au compte gérant.
//   GET|POST /mail/unsubscribe?t=<jeton>  désinscription de la newsletter : GET renvoie vers la
//                        page du site, POST désinscrit en un clic (en-tête List-Unsubscribe).
//   POST /mail/push-test notification de test sur les appareils du gérant.
//
// Les nouvelles demandes et les messages reçus déclenchent aussi une notification
// sur les appareils où le gérant l'a activée (Web Push, table push_subscriptions).
//
// Secrets de la fonction : RESEND_API_KEY, RESEND_WEBHOOK_SECRET, HOOK_SECRET,
// NOTIFY_TO, MAIL_FROM, SITE_URL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_JWK.
// Aucun secret dans ce fichier.

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

// Renvoie le compte gérant correspondant au jeton, ou null
async function adminUser(authorization: string): Promise<{ id: string; email?: string } | null> {
  if (!/^Bearer\s+\S+/i.test(authorization)) return null;
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_SERVICE_ROLE_KEY'), Authorization: authorization },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;
  const rows = await db(`/admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`);
  return Array.isArray(rows) && rows.length === 1 ? user : null;
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
    const err = new Error(`Resend ${res.status} sur ${path} : ${typeof data === 'string' ? data : JSON.stringify(data)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
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

type Row = Record<string, any>;

// ---------------------------------------------------------------- Notifications push (Web Push : RFC 8291 et 8292)
// Écrit avec WebCrypto, sans dépendance : chiffrement « aes128gcm » du message
// pour l'appareil, et jeton VAPID signé avec la clé privée de la fonction.
const b64u = (bytes: Uint8Array) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (v: string) => {
  const t = v.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(t + '==='.slice((t.length + 3) % 4)), (c) => c.charCodeAt(0));
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

async function encryptPush(payload: Uint8Array, p256dh: string, auth: string) {
  const enc = new TextEncoder();
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("Abonnement de l'appareil invalide.");
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // un seul enregistrement : le contenu suivi du délimiteur 0x02
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

async function vapidAuthorization(endpoint: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env('VAPID_PRIVATE_JWK')), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: `mailto:${FROM_ADDRESS()}` })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${env('VAPID_PUBLIC_KEY')}`;
}

type PushNote = { title: string; body: string; url?: string; tag?: string };

async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, note: PushNote) {
  if (!/^https:\/\//.test(sub.endpoint)) throw new Error('Adresse de notification invalide.');
  const body = await encryptPush(new TextEncoder().encode(JSON.stringify(note)), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body,
  });
  await res.arrayBuffer().catch(() => null);
  return res.status;
}

// Envoie la notification à tous les appareils enregistrés (ou à un seul, pour le test)
async function pushAll(note: PushNote, onlyEndpoint = '') {
  const out = { total: 0, sent: 0, expired: 0, failed: 0, errors: [] as string[] };
  if (!env('VAPID_PRIVATE_JWK') || !env('VAPID_PUBLIC_KEY')) {
    out.errors.push('Notifications non configurées.');
    return out;
  }
  const subs: Row[] = (await db('/push_subscriptions?select=id,endpoint,p256dh,auth')) ?? [];
  const list = onlyEndpoint ? subs.filter((x) => x.endpoint === onlyEndpoint) : subs;
  out.total = list.length;
  await Promise.all(list.map(async (sub) => {
    try {
      const status = await sendPush(sub as { endpoint: string; p256dh: string; auth: string }, note);
      if (status >= 200 && status < 300) out.sent++;
      else if (status === 404 || status === 410) {
        // l'appareil s'est désabonné : on oublie son abonnement
        out.expired++;
        await db(`/push_subscriptions?id=eq.${sub.id}`, { method: 'DELETE', prefer: 'return=minimal' });
      } else {
        out.failed++;
        out.errors.push(`Réponse ${status}`);
      }
    } catch (e) {
      out.failed++;
      out.errors.push(e instanceof Error ? e.message : String(e));
    }
  }));
  return out;
}

// Une notification qui échoue ne doit jamais bloquer un e-mail ni une réservation
const safePush = (note: PushNote) => pushAll(note).catch((e) => {
  console.error('push', e);
  return null;
});

// ---------------------------------------------------------------- Notifications par e-mail

function bookingRows(b: Row, forOwner: boolean): [string, string][] {
  const formule = `${esc(b.service_name || b.service || 'Séance')}${Number(b.people) > 1 ? ' × ' + esc(b.people) : ''}`;
  const where = b.kind === 'domicile' ? esc(b.address || 'À domicile') : esc(b.reception_address || b.location || b.base_location || '');
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
    const pushed = await safePush({
      title: 'Nouvelle demande de réservation',
      body: `${r.client_name || 'Un client'} · ${r.service_name || 'séance'} · ${when}`,
      url: `${SITE()}/gestion.html#agenda`, tag: `booking-${r.id}`,
    });
    if (pushed?.sent) sent.push('push');
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
    const pushed = await safePush({
      title: 'Demande de test pilote',
      body: `${r.name || 'Un club'}${r.contact_name ? ' · ' + r.contact_name : ''}`,
      url: `${SITE()}/gestion.html#clients`, tag: `club-${r.id}`,
    });
    if (pushed?.sent) sent.push('push');
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

// Le webhook Resend est commun à tous les domaines du compte : cette application
// ne traite que les messages adressés à son propre domaine (celui de MAIL_FROM).
// On se fie d'abord au destinataire réel de la livraison (« received_for »), qui
// couvre aussi les copies cachées ; à défaut, aux champs À, Cc et Cci.
const ownDomain = () => (FROM_ADDRESS().split('@')[1] ?? '').trim().toLowerCase();
const addressesOf = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => parseAddress(x).email.toLowerCase());
function isForOwnDomain(mail: Row) {
  const suffix = `@${ownDomain()}`;
  const envelope = addressesOf(mail.received_for);
  const recipients = envelope.length ? envelope : [...addressesOf(mail.to), ...addressesOf(mail.cc), ...addressesOf(mail.bcc)];
  return suffix.length > 1 && recipients.some((a) => a.endsWith(suffix));
}

async function forwardInbound(emailId: string) {
  const owner = env('NOTIFY_TO');
  if (!owner) throw new Error('NOTIFY_TO manquant');
  const mail = await resend(`/emails/receiving/${emailId}`);
  // message d'un autre domaine du compte : ni enregistré, ni copié, ni notifié
  if (!isForOwnDomain(mail)) return 'ignoré : autre domaine';
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(mail.headers ?? {})) headers[k.toLowerCase()] = String(v);
  if (headers['x-presso-forwarded']) return 'déjà transféré';

  const sender = parseAddress(mail.from);
  const replyTo = Array.isArray(mail.reply_to) && mail.reply_to.length ? mail.reply_to : [sender.email];
  const to = (Array.isArray(mail.to) ? mail.to : [mail.to]).filter(Boolean).join(', ');

  // Messagerie de l'espace de gestion : texte seul, jamais de HTML reçu de l'extérieur
  const stored = await db('/messages?on_conflict=resend_id', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=representation',
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
  // (rien si le webhook est rejoué : le message est déjà enregistré)
  if (Array.isArray(stored) && stored.length) {
    await safePush({
      title: `Message de ${(sender.name || sender.email).slice(0, 60)}`,
      body: String(mail.subject || '(sans objet)').slice(0, 140),
      url: `${SITE()}/gestion.html#messages`, tag: `message-${emailId}`,
    });
  }

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

// ---------------------------------------------------------------- Newsletter
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_RE = /\[[^\]\n]{1,60}\]/;

// Texte simple -> HTML : paragraphes, retours à la ligne, adresses web cliquables
function richText(text: string) {
  return text.split(/\n{2,}/).map((par) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#2b3140">${
      esc(par).replace(/https?:\/\/[^\s<]+/g, (raw) => {
        const url = raw.replace(/[.,;:!?)]+$/, '');
        return `<a href="${url}" style="color:#8a6a2f">${url}</a>${raw.slice(url.length)}`;
      }).replace(/\n/g, '<br>')
    }</p>`).join('');
}

function newsletterEmail(subject: string, body: string, cta: boolean, r: { email: string; name?: string | null; token?: string | null }, test: boolean) {
  // « {prénom} » est remplacé par le prénom de l'abonné, ou retiré s'il est inconnu
  const text = body.replace(/\{pr[ée]nom\}/gi, firstName(r.name)).replace(/^(Bonjour|Bonsoir|Salut|Hello)[ \t]+,/gim, '$1,');
  const page = `${SITE()}/desinscription.html${r.token ? `?t=${r.token}` : ''}`;
  const oneClick = r.token ? `${env('SUPABASE_URL')}/functions/v1/mail/unsubscribe?t=${r.token}` : '';
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f6f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f1623">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ef"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="background:#0f1623;border-radius:16px 16px 0 0;padding:20px 28px;color:#c4a062;font-size:12px;font-weight:800;letter-spacing:.22em">PRESSO CENTER</td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 16px 16px;padding:28px">
<h1 style="margin:0 0 18px;font-size:22px;line-height:1.25;color:#0f1623">${esc(subject)}</h1>
${richText(text)}
${cta ? `<p style="margin:4px 0 0"><a href="${esc(SITE())}/reserver.html" style="display:inline-block;background:#c4a062;color:#0f1623;text-decoration:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:999px">Réserver une séance</a></p>` : ''}
</td></tr>
<tr><td style="padding:16px 8px;text-align:center;font-size:12px;line-height:1.6;color:#626977">Presso Center · Récupération sportive · Tours · <a href="${esc(SITE())}" style="color:#626977">${esc(SITE().replace(/^https?:\/\//, ''))}</a><br>Tu reçois cette newsletter parce que tu t'es inscrit(e) sur le site ou lors d'une réservation. <a href="${esc(page)}" style="color:#626977">Se désinscrire</a></td></tr>
</table></td></tr></table></body></html>`;
  return {
    from: FROM(), to: [r.email], reply_to: FROM_ADDRESS(), subject: (test ? '[Test] ' : '') + subject, html,
    text: `${text}\n\n${cta ? `Réserver une séance : ${SITE()}/reserver.html\n\n` : ''}--\nPresso Center · ${SITE()}\nSe désinscrire : ${page}`,
    ...(oneClick ? { headers: { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
  };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendNewsletter(p: Record<string, any>, user: { email?: string }) {
  const subject = String(p.subject ?? '').trim();
  const body = String(p.body ?? '').trim();
  const id = String(p.id ?? '');
  const test = p.test === true;
  if (!subject || subject.length > 200) throw new Error("L'objet est obligatoire (200 caractères maximum).");
  if (!body || body.length > 20000) throw new Error('La newsletter est vide ou trop longue.');
  if (!UUID_RE.test(id)) throw new Error('Identifiant de la newsletter manquant.');
  if (PLACEHOLDER_RE.test(subject) || PLACEHOLDER_RE.test(body)) throw new Error('Il reste un passage entre crochets à compléter.');

  let recipients: { email: string; name?: string | null; token?: string | null }[];
  if (test) {
    const to = String(user.email ?? '').trim();
    if (!EMAIL_RE.test(to)) throw new Error("Ton compte n'a pas d'adresse e-mail pour recevoir le test.");
    recipients = [{ email: to, name: '', token: null }];
  } else {
    recipients = ((await db('/subscribers?unsubscribed_at=is.null&select=email,name,token&order=created_at.asc&limit=2000')) ?? [])
      .filter((r: Row) => EMAIL_RE.test(String(r.email ?? '')));
    if (!recipients.length) throw new Error("Aucun abonné pour l'instant.");
  }

  const emails = recipients.map((r) => newsletterEmail(subject, body, p.cta !== false, r, test));
  let sent = 0;
  const failed: string[] = [];
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    const prefix = `newsletter/${id}/${test ? 'test' : 'liste'}/${i}`;
    try {
      if (chunk.length === 1) await sendEmail(chunk[0], prefix);
      else await resend('/emails/batch', { method: 'POST', body: chunk, idempotencyKey: `batch-${prefix}` });
      sent += chunk.length;
    } catch (e) {
      const status = (e as { status?: number }).status;
      // Envoi groupé refusé pour une adresse ou un format : on repasse en envois un par un
      if (chunk.length > 1 && (status === 400 || status === 422)) {
        for (let j = 0; j < chunk.length; j++) {
          try {
            await sendEmail(chunk[j], `${prefix}/${j}`);
            sent++;
          } catch (err) {
            console.error('newsletter', err);
            failed.push(chunk[j].to[0]);
          }
          await pause(550);
        }
      } else {
        console.error('newsletter', e);
        failed.push(...chunk.map((m) => m.to[0]));
      }
    }
    if (i + 100 < emails.length) await pause(600);
  }

  let message = null;
  if (!test && sent) {
    const rows = await db('/messages?on_conflict=id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: { id, direction: 'out', from_name: 'Presso Center', from_email: FROM_ADDRESS(), to_email: `Newsletter · ${sent} abonné${sent > 1 ? 's' : ''}`, subject, body, read: true },
    });
    message = rows?.[0] ?? null;
  }
  if (!sent) throw new Error("L'envoi a échoué. Réessaie dans quelques minutes.");
  return { sent, failed: failed.length, total: emails.length, to: test ? recipients[0].email : null, message };
}

// ---------------------------------------------------------------- Entrée
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  // Routes appelées par l'espace de gestion, depuis le navigateur
  const appRoute = /\/(send|newsletter|push-test)$/.test(path);
  if (appRoute && req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });

  try {
    // Désinscription de la newsletter : lien cliqué (GET) ou bouton du logiciel de messagerie (POST)
    if (path.endsWith('/unsubscribe')) {
      const token = url.searchParams.get('t') ?? '';
      if (!UUID_RE.test(token)) return json({ ok: false, error: 'Lien invalide' }, 400);
      if (req.method === 'GET') return new Response(null, { status: 302, headers: { Location: `${SITE()}/desinscription.html?t=${token}` } });
      if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);
      const out = await db('/rpc/newsletter_unsubscribe', { method: 'POST', body: { p_token: token } });
      return json({ ok: !!out?.ok });
    }

    if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);

    if (appRoute) {
      const user = await adminUser(req.headers.get('authorization') ?? '');
      if (!user) return json({ error: 'Non autorisé' }, 401, cors(req));
      try {
        const p = await req.json().catch(() => ({}));
        if (path.endsWith('/send')) return json({ ok: true, message: await sendFromApp(p) }, 200, cors(req));
        if (path.endsWith('/newsletter')) return json({ ok: true, ...(await sendNewsletter(p, user)) }, 200, cors(req));
        const result = await pushAll(
          { title: 'Presso Center', body: 'Les notifications fonctionnent sur cet appareil.', url: `${SITE()}/gestion.html`, tag: 'test' },
          String(p?.endpoint ?? ''),
        );
        return json({ ok: result.sent > 0, ...result }, 200, cors(req));
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
