/**
 * Default-Bausteine für DentDoc
 * Diese werden verwendet, wenn die Praxis keine eigenen Bausteine definiert hat.
 *
 * Jeder Baustein enthält:
 * - name: Anzeigename der Kategorie
 * - standardText: Der Standard-Aufklärungstext (wird IMMER eingefügt wenn Kategorie erkannt)
 * - keywords: Schlüsselwörter zur Kategorie-Erkennung
 */

const DEFAULT_BAUSTEINE = {
  FUELLUNG: {
    name: 'Füllungstherapie',
    standardText: 'Patient wurde über Kosten, Zuzahlungen, Materialalternativen (Kunststoff, Keramik, Amalgam) sowie Risiken der Füllungstherapie aufgeklärt.',
    keywords: ['füllung', 'karies', 'loch', 'kunststoff', 'amalgam', 'keramik', 'komposit', 'kavität']
  },
  ZE_BERATUNG: {
    name: 'Zahnersatz-Beratung',
    standardText: 'Patient wurde über Versorgungsalternativen, Festzuschuss-Systematik und mögliche Eigenanteile aufgeklärt.',
    keywords: ['zahnersatz', 'krone', 'brücke', 'prothese', 'implantat', 'festzuschuss', 'hkp', 'heil- und kostenplan']
  },
  EXTRAKTION: {
    name: 'Zahnentfernung',
    standardText: 'Patient wurde über Risiken (Nachblutung, Schwellung, Nervschädigung), Verhaltenshinweise und Alternativen zur Extraktion aufgeklärt.',
    keywords: ['extraktion', 'ziehen', 'entfernen', 'zahn raus', 'zahn muss raus', 'weisheitszahn']
  },
  PZR: {
    name: 'Professionelle Zahnreinigung',
    standardText: 'Patient wurde über Ablauf, Kosten und Nutzen der professionellen Zahnreinigung aufgeklärt.',
    keywords: ['pzr', 'zahnreinigung', 'prophylaxe', 'reinigung', 'politur', 'zahnstein']
  },
  WKB: {
    name: 'Wurzelkanalbehandlung',
    standardText: 'Patient wurde über Ablauf, Risiken, Erfolgsaussichten und Alternativen der Wurzelkanalbehandlung aufgeklärt.',
    keywords: ['wurzelbehandlung', 'wurzelkanal', 'wkb', 'endo', 'nerv', 'wurzel', 'endodontie']
  },
  PA: {
    name: 'Parodontitis-Behandlung',
    standardText: 'Patient wurde über Befund, Therapieablauf, Nachsorge und Eigenverantwortung bei der Parodontitisbehandlung aufgeklärt.',
    keywords: ['parodontitis', 'parodontose', 'pa', 'zahnfleisch', 'taschen', 'parodontal']
  },
  KONTROLLE: {
    name: 'Kontrolluntersuchung',
    standardText: 'Kontrolluntersuchung durchgeführt.',
    keywords: ['kontrolle', 'check', 'nachschauen', 'kontrolltermin', 'recall', 'nachkontrolle']
  },
  SCHMERZBEHANDLUNG: {
    name: 'Schmerzbehandlung',
    standardText: 'Patient stellte sich mit akuten Beschwerden vor. Über Befund, Verdachtsdiagnose und Therapieoptionen wurde aufgeklärt.',
    keywords: ['schmerzen', 'schmerz', 'akut', 'notfall', 'beschwerden', 'weh']
  }
};

module.exports = { DEFAULT_BAUSTEINE };
