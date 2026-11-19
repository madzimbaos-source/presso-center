/* Presso Center — page d'accueil.
   Les tarifs, les forfaits et le prochain créneau libre viennent de la plateforme
   de réservation ; les valeurs par défaut s'affichent tout de suite, puis sont
   remplacées par celles de la base. */
(function () {
  'use strict';
  const PC = window.PC;
  const esc = PC.esc;
  const $ = (s) => document.querySelector(s);
  const CONTACT_EMAIL = 'contact@pressocenter.fr';

  document.querySelectorAll('[data-ic]').forEach((el) => el.insertAdjacentHTML('afterbegin', PC.icon(el.dataset.ic)));

  let info = PC.publicSubset(PC.mergeSettings({}), 5);

  function render() {
    const services = (info.services || []).filter((s) => s.online !== false);
    $('#formules').innerHTML = services.map((s) =>
      '<a class="lp-formule" href="reserver.html?formule=' + encodeURIComponent(s.code) + '">' +
      '<span class="name">' + esc(s.name) + '</span>' +
      '<span class="price">' + PC.eur(s.price) + (s.per_person ? ' <small>/ pers.</small>' : '') + '</span>' +
      '<span class="meta">' + PC.durationLabel(s.duration) + ' · ' + esc(s.desc || '') + '</span>' +
      '<span class="go">Réserver ' + PC.icon('right') + '</span></a>').join('');

    $('#packs').innerHTML = (info.packs || []).map((p) => '<span><b>' + esc(p.name) + ' : ' + PC.eur(p.price) + '</b> · ' + esc(p.desc) + '</span>').join('');

    const plans = info.club_plans || [];
    $('#plans').innerHTML = plans.map((p) =>
      '<div class="lp-plan"><span class="eyebrow">' + esc(p.name) + '</span>' +
      '<span class="price">' + PC.eur(p.price) + ' <small>/ mois</small></span>' +
      '<span class="pp">≈ ' + PC.eur(PC.round2(p.price / (p.passages || 1))) + ' par passage</span>' +
      '<span class="t">' + esc(p.target) + '</span><span class="d">' + esc(p.desc) + '</span></div>').join('');

    const cap = Number(info.capacity) || 5;
    const best = plans.length ? Math.min.apply(null, plans.map((p) => p.price / (p.passages || 1))) : 0;
    $('#club-stats').innerHTML =
      '<div class="lp-stat"><b>' + cap + '</b><span>athlètes pris en charge en même temps</span></div>' +
      '<div class="lp-stat"><b>' + cap * 3 + '</b><span>passages par créneau d\'1h30</span></div>' +
      (best ? '<div class="lp-stat"><b>' + PC.eur(PC.round2(best)) + '</b><span>par passage, selon le forfait</span></div>' : '');
    $('#discount').textContent = Math.round((info.season_discount || 0.1) * 100);

    const from = services.length ? Math.min.apply(null, services.map((s) => Number(s.price))) : 20;
    document.querySelectorAll('[data-from]').forEach((el) => (el.textContent = PC.eur(from)));

    const email = info.email || CONTACT_EMAIL;
    const mail = $('#contact-mail');
    mail.textContent = email;
    mail.href = 'mailto:' + email;
    const wa = $('#contact-wa');
    if (info.phone) {
      wa.href = PC.waLink(info.phone, 'Bonjour, j\'ai une question sur Presso Center.');
      wa.classList.remove('hide');
    } else wa.classList.add('hide');
  }

  function showNextSlot(busy) {
    const svc = (info.services || []).find((s) => s.online !== false && s.kind !== 'domicile' && !s.per_person);
    if (!svc || !info.capacity) return;
    const now = new Date();
    const today = PC.startOfDay(now);
    for (let i = 0; i <= (info.max_days_ahead || 28); i++) {
      const day = PC.addDays(today, i);
      const slots = PC.slotsForDay(day, svc, 1, busy, info, info.capacity, now);
      if (slots.length) {
        const el = $('#next-slot');
        el.querySelector('span').innerHTML = 'Prochain créneau libre : <b>' + esc(PC.fmtDay(slots[0].start, { weekday: 'long', day: 'numeric', month: 'long' })) + ' à ' + PC.fmtTime(slots[0].start) + '</b>';
        el.classList.remove('hide');
        return;
      }
    }
  }

  render();

  // Un seul accès à la plateforme pour toute la page
  let store = null;
  const getStore = () => store || (store = PC.createStore());

  const letter = $('#letter-form');
  if (letter) {
    letter.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#letter-msg');
      const say = (text, cls) => {
        msg.textContent = text;
        msg.className = 'lp-letter-msg ' + cls;
      };
      const email = letter.elements.email.value.trim();
      if (!PC.isEmail(email)) return say('Vérifie ton adresse e-mail.', 'bad');
      const btn = letter.querySelector('button');
      btn.disabled = true;
      try {
        await getStore().subscribe({ email, source: 'site' });
        letter.elements.email.value = '';
        say('C\'est noté : tu recevras la prochaine newsletter.', 'good');
      } catch (err) {
        say(err.message || 'Inscription impossible pour le moment.', 'bad');
      }
      btn.disabled = false;
    });
  }

  (async function () {
    try {
      const store = getStore();
      info = await store.publicInfo();
      render();
      const now = new Date();
      const busy = await store.publicBusy(PC.addDays(PC.startOfDay(now), -1), PC.addDays(now, (info.max_days_ahead || 28) + 2));
      showNextSlot(busy);
    } catch (e) {
      // La page reste complète avec les tarifs par défaut.
      console.warn('Tarifs en direct indisponibles :', e.message);
    }
  })();
})();
