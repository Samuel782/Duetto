// Avviso al pubblico: sottotitoli generati con AI. Nella lingua dell'uscita, altrimenti in inglese.
const TEXTS = {
  it: 'Sottotitoli e traduzioni generati con AI: possono contenere errori',
  en: 'AI-generated subtitles and translations: may contain errors',
  es: 'Subtítulos y traducciones generados con IA: pueden contener errores',
  fr: 'Sous-titres et traductions générés par IA : ils peuvent contenir des erreurs',
  de: 'KI-generierte Untertitel und Übersetzungen: können Fehler enthalten',
  pt: 'Legendas e traduções geradas com IA: podem conter erros',
  nl: 'Door AI gegenereerde ondertitels en vertalingen: kunnen fouten bevatten',
};
export const MAX_NOTICE = 160;

export const noticeText = (enabled, custom, lang) => (enabled ? custom || TEXTS[lang] || TEXTS.en : '');
