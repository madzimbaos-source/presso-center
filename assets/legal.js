/* Presso Center — pages d'information : complète l'identité de l'éditeur
   à partir des réglages (Réglages → Informations légales). */
(function () {
  'use strict';
  const PC = window.PC;
  const set = (key, value) => document.querySelectorAll('[data-legal="' + key + '"]').forEach((el) => {
    if (value) el.textContent = value;
  });
  const show = (key, on) => document.querySelectorAll('[data-legal-if="' + key + '"]').forEach((el) => el.classList.toggle('hide', !on));
  (async function () {
    try {
      const info = await PC.createStore().publicInfo();
      const L = info.legal || {};
      set('business', info.business_name);
      set('name', L.name);
      set('status', L.status);
      set('siret', L.siret);
      set('address', L.address);
      set('phone', info.phone);
      set('mediator', L.mediator);
      show('phone', !!info.phone);
      show('mediator', !!L.mediator);
      show('no-mediator', !L.mediator);
      const email = info.email || 'contact@pressocenter.fr';
      document.querySelectorAll('[data-legal="email"]').forEach((el) => {
        el.textContent = email;
        if (el.tagName === 'A') el.href = 'mailto:' + email;
      });
    } catch (e) {
      console.warn('Informations légales : valeurs par défaut affichées.', e.message);
    }
  })();
})();
