/* Connexion à la base Supabase de Presso Center.
   Vide = mode démo : tout reste dans le navigateur, rien n'est partagé.
   La clé « publishable » est publique par conception : la sécurité repose
   sur les règles RLS de la base (voir supabase/schema.sql).
   « vapidPublicKey » est la clé publique des notifications : la clé privée
   correspondante est un secret de la fonction « mail », jamais ici. */
window.PRESSO_CONFIG = {
  supabaseUrl: 'https://pbiyyuemvcoexzbkavab.supabase.co',
  supabaseKey: 'sb_publishable_3xngeqisgMYAtPDFCyv9gw_8ERnJn1r',
  vapidPublicKey: 'BLd_joUXOwPkIl9W17rqMmD_dpOrst4G61Xi-2AVgoPajFJOa7rxie_4-esBUUAj1UW_D5-tZiFmbd7gROgJYvE'
};
