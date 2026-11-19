/* Presso Center — désinscription de la newsletter.
   Le lien reçu par e-mail contient un jeton personnel (?t=...). La désinscription
   demande un clic sur la page : un simple chargement du lien ne désinscrit personne. */
(function () {
  'use strict';
  const PC = window.PC;
  const box = document.querySelector('#unsub');
  const btn = document.querySelector('#unsub-btn');
  const token = new URLSearchParams(location.search).get('t') || '';
  const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
  const say = (html) => {
    box.innerHTML = html;
  };
  const mail = '<a href="mailto:contact@pressocenter.fr">contact@pressocenter.fr</a>';
  if (!valid) {
    say('<p>Ce lien de désinscription est incomplet. Ouvre-le de nouveau depuis la newsletter reçue, ou écris-nous à ' + mail + ' : on te retire de la liste.</p>');
    return;
  }
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const out = await PC.createStore().unsubscribe(token);
      if (out && out.ok) say('<p><b>C\'est fait.</b> ' + (out.email ? 'L\'adresse ' + PC.esc(out.email) + ' ne recevra plus la newsletter.' : 'Tu ne recevras plus la newsletter.') + '</p><p style="margin-top:12px">Les e-mails liés à tes réservations (accusé de réception, confirmation) continuent d\'être envoyés.</p>');
      else say('<p>Cette adresse n\'est plus dans notre liste : il n\'y a rien à faire.</p>');
    } catch (e) {
      btn.disabled = false;
      say('<p>La désinscription n\'a pas pu être enregistrée. Réessaie dans un instant, ou écris-nous à ' + mail + '.</p><p style="margin-top:20px"><button class="btn" type="button" onclick="location.reload()">Réessayer</button></p>');
    }
  });
})();
