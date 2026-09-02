import { useMemo, useState } from "react";
import { ArrowLeft, BookOpenCheck, ExternalLink, FileText, Printer, ShieldCheck } from "lucide-react";
import { Link } from "wouter";
import { legalKitConfig } from "@/lib/legal-kit-config";

type LegalDocument = "devis" | "contrat" | "notice";

const money = (value: number) =>
  new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(value);

const dateValue = (date: Date) => date.toISOString().slice(0, 10);

const articleContents = [
  ["Identité des parties", "Le prestataire et le client sont identifiés avec leur qualité, leur adresse et leurs coordonnées. Les dispositions protectrices du Code de la consommation s’appliquent lorsque le client agit comme consommateur."],
  ["Objet du contrat", "NovaLuth fournit un service numérique d’annuaire et de mise en relation. NovaLuth n’est pas partie au contrat conclu entre un musicien et un atelier et ne garantit ni la réalisation de l’instrument ni les travaux de l’atelier."],
  ["Documents contractuels", "Le contrat est formé du présent document, du devis accepté et de ses annexes. En cas de contradiction, le devis accepté prévaut pour le prix, le périmètre et les délais."],
  ["Durée, délais et exécution", "La prestation débute à la date indiquée au devis. À défaut de date, elle est exécutée sans délai injustifié et au plus tard trente jours après la conclusion du contrat."],
  ["Obligations du prestataire", "Le prestataire exécute la prestation conformément au devis, informe le client de tout événement affectant le contenu ou le délai et maintient les assurances applicables."],
  ["Obligations du client", "Le client fournit les informations nécessaires, valide les livrables intermédiaires et règle le prix aux échéances convenues, sans que ces obligations puissent faire échec aux garanties légales."],
  ["Prix, facturation et paiement", "Le prix, la TVA éventuelle, l’échéancier et le moyen de paiement figurent au devis. Toute prestation supplémentaire fait l’objet d’un avenant écrit accepté avant exécution."],
  ["Droit de rétractation", "Pour un contrat conclu à distance ou hors établissement avec un consommateur, le délai est de quatorze jours. Une exécution avant son terme suppose une demande expresse et l’information sur ses conséquences."],
  ["Garanties légales", "Les garanties légales de conformité et des vices cachés s’appliquent intégralement lorsqu’elles sont pertinentes. Elles ne peuvent être exclues ou limitées par le contrat."],
  ["Responsabilité et assurance", "Le prestataire répond des dommages directs causés par un manquement à ses obligations. Aucune clause ne réduit le droit à réparation du consommateur."],
  ["Force majeure", "Aucune partie n’est responsable d’un manquement causé par un événement de force majeure au sens de l’article 1218 du Code civil. La partie empêchée informe l’autre sans délai."],
  ["Propriété intellectuelle", "Les méthodes et outils préexistants restent la propriété de leur titulaire. Toute cession de droits sur un livrable précise les droits, supports, territoire et durée concernés."],
  ["Confidentialité", "Chaque partie protège les informations confidentielles reçues de l’autre pendant le contrat et pendant la durée prévue après son terme, sous réserve des exceptions légales."],
  ["Données personnelles", "Les données sont traitées pour l’exécution du contrat, la facturation, le suivi de la relation commerciale et les obligations légales. Les droits s’exercent à l’adresse RGPD indiquée ci-dessous."],
  ["Modification, suspension et résiliation", "Toute modification du périmètre fait l’objet d’un avenant écrit. La résiliation pour manquement grave intervient après mise en demeure restée sans effet pendant quinze jours."],
  ["Réclamation et médiation", "Toute réclamation est adressée à l’adresse dédiée. À défaut de solution satisfaisante, le consommateur peut recourir gratuitement au médiateur dont relève le prestataire."],
  ["Absence de clauses abusives", "Aucune clause ne doit créer de déséquilibre significatif au détriment du consommateur. Une clause abusive est réputée non écrite et le reste du contrat demeure applicable."],
  ["Droit applicable et litiges", "Le contrat est soumis au droit français. Le consommateur conserve le choix de la juridiction prévu par l’article R631-3 du Code de la consommation."],
  ["Signatures", "Le contrat est signé en deux exemplaires, chaque partie reconnaissant avoir reçu le sien et pris connaissance des clauses et annexes."],
] as const;

const noticeRows = [
  ["Identité complète", "L111-1 ; R123-237 C. com.", "Identifier le cocontractant", "Devis contestable ou information incomplète"],
  ["Prix et décompte", "L112-1 ; art. 289 CGI", "Rendre le prix vérifiable", "Litige sur le périmètre ou le total"],
  ["Délais d’exécution", "L216-1 à L216-3", "Encadrer le retard", "Délai légal de trente jours applicable"],
  ["Rétractation", "L221-18 à L221-28", "Informer le consommateur à distance", "Délai prolongé et remboursement"],
  ["Garanties légales", "L217-3 et suivants", "Rappeler un droit impératif", "Garantie opposable sans limitation"],
  ["Médiation", "L612-1 ; L616-1", "Offrir un recours amiable gratuit", "Information obligatoire manquante"],
  ["Données personnelles", "RGPD, articles 12 à 22", "Expliquer l’usage des données", "Réclamation CNIL et sanction possible"],
] as const;

function LegalKitHeader({ document }: { document: LegalDocument }) {
  const titles = {
    devis: ["Outil", "Générateur de devis"],
    contrat: ["Document", "Contrat de prestation de services"],
    notice: ["Pédagogie", "Notice explicative des clauses"],
  } as const;
  const [eyebrow, title] = titles[document];
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/60 pb-6 print:hidden">
      <div>
        <Link href="/legal" className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary">
          <ArrowLeft className="h-4 w-4" /> Retour aux informations légales
        </Link>
        <p className="text-xs uppercase tracking-[0.22em] text-primary">{eyebrow}</p>
        <h1 className="mt-2 text-3xl text-foreground md:text-4xl">{title}</h1>
      </div>
      <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-2 border border-primary/40 px-4 py-2 text-sm text-primary hover:bg-primary/10">
        <Printer className="h-4 w-4" /> Imprimer / PDF
      </button>
    </div>
  );
}

function LegalWarning() {
  return (
    <div className="border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-foreground">
      <strong>Avant utilisation réelle :</strong> remplacez les champs marqués A_COMPLETER, adhérez à un médiateur agréé et faites relire ces modèles par un professionnel du droit.
    </div>
  );
}

function LegalDocumentNav({ current }: { current: LegalDocument }) {
  const entries: Array<[LegalDocument, string]> = [
    ["devis", "Générateur de devis"],
    ["contrat", "Contrat"],
    ["notice", "Notice"],
  ];
  return (
    <nav className="flex flex-wrap gap-2 print:hidden" aria-label="Documents juridiques">
      {entries.map(([key, label]) => (
        <Link key={key} href={`/legal/${key}`} className={`border px-3 py-2 text-sm transition-colors ${current === key ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/50 hover:text-primary"}`}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

function DevisDocument() {
  const today = useMemo(() => new Date(), []);
  const [client, setClient] = useState("Nom du client");
  const [clientAddress, setClientAddress] = useState("");
  const [quality, setQuality] = useState<"conso" | "pro">("conso");
  const [mode, setMode] = useState<"distance" | "etablissement" | "hors">("distance");
  const [prestationKey, setPrestationKey] = useState<string>(legalKitConfig.prestations[0].cle);
  const [objet, setObjet] = useState("");
  const [amount, setAmount] = useState(legalKitConfig.prestations[0].prix.toString());
  const [date, setDate] = useState(dateValue(today));
  const [validUntil, setValidUntil] = useState(dateValue(new Date(today.getTime() + legalKitConfig.devis.validiteJours * 86_400_000)));

  const prestation = legalKitConfig.prestations.find((item) => item.cle === prestationKey) ?? legalKitConfig.prestations[0];
  const total = Number.isFinite(Number(amount)) ? Math.max(0, Number(amount)) : 0;
  const reference = `${legalKitConfig.devis.prefixe}-${date.replaceAll("-", "")}`;

  const choosePrestation = (key: string) => {
    const next = legalKitConfig.prestations.find((item) => item.cle === key) ?? legalKitConfig.prestations[0];
    setPrestationKey(next.cle);
    setAmount(next.prix.toString());
    setObjet(next.objet);
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)]">
      <form className="space-y-5 print:hidden" onSubmit={(event) => event.preventDefault()}>
        <fieldset className="space-y-4 border border-border/60 p-5">
          <legend className="px-2 font-serif text-lg text-primary">Références</legend>
          <label className="block text-sm text-muted-foreground">Date
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-1 w-full border border-border bg-background px-3 py-2 text-foreground" />
          </label>
          <label className="block text-sm text-muted-foreground">Valable jusqu’au
            <input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} className="mt-1 w-full border border-border bg-background px-3 py-2 text-foreground" />
          </label>
        </fieldset>
        <fieldset className="space-y-4 border border-border/60 p-5">
          <legend className="px-2 font-serif text-lg text-primary">Client</legend>
          <label className="block text-sm text-muted-foreground">Nom ou raison sociale
            <input value={client} onChange={(event) => setClient(event.target.value)} className="mt-1 w-full border border-border bg-background px-3 py-2 text-foreground" />
          </label>
          <label className="block text-sm text-muted-foreground">Adresse
            <input value={clientAddress} onChange={(event) => setClientAddress(event.target.value)} placeholder="Adresse complète" className="mt-1 w-full border border-border bg-background px-3 py-2 text-foreground" />
          </label>
          <label className="block text-sm text-muted-foreground">Qualité
            <select value={quality} onChange={(event) => setQuality(event.target.value as "conso" | "pro")} className="mt-1 w-full border border-border bg-background px-3 py-2 text-foreground">
              <option value="conso">Consommateur (particulier)</option>
              <option value="pro">Professionnel</option>
            </select>
          </label>
          <label className="block text-sm text-muted-foreground">Mode de conclusion
            <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)} className="mt-1 w-full border border-border bg-background px-3 py-2 text-foreground">
              <option value="distance">À distance</option>
              <option value="etablissement">Dans l’établissement</option>
              <option value="hors">Hors établissement</option>
            </select>
          </label>
        </fieldset>
        <fieldset className="space-y-4 border border-border/60 p-5">
          <legend className="px-2 font-serif text-lg text-primary">Prestation</legend>
          <label className="block text-sm text-muted-foreground">Modèle NovaLuth
            <select value={prestationKey} onChange={(event) => choosePrestation(event.target.value)} className="mt-1 w-full border border-border bg-background px-3 py-2 text-foreground">
              {legalKitConfig.prestations.map((item) => <option key={item.cle} value={item.cle}>{item.titre}</option>)}
            </select>
          </label>
          <label className="block text-sm text-muted-foreground">Objet
            <textarea value={objet} onChange={(event) => setObjet(event.target.value)} placeholder={prestation.objet} rows={4} className="mt-1 w-full border border-border bg-background px-3 py-2 text-foreground" />
          </label>
          <label className="block text-sm text-muted-foreground">Montant TTC (€)
            <input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} className="mt-1 w-full border border-border bg-background px-3 py-2 text-foreground" />
          </label>
        </fieldset>
      </form>
      <article className="min-w-0 border border-border bg-card p-6 shadow-sm md:p-10">
        <div className="flex flex-wrap justify-between gap-6 border-b border-border pb-6">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-primary">Devis</p>
            <h2 className="mt-2 text-2xl text-foreground">{legalKitConfig.entreprise.nom}</h2>
            <p className="text-sm text-muted-foreground">{legalKitConfig.entreprise.formeJuridique}<br />{legalKitConfig.entreprise.adresse}<br />{legalKitConfig.entreprise.email}</p>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <p><strong className="text-foreground">N° {reference}</strong></p>
            <p>Établi le {date || "—"}</p>
            <p>Valable jusqu’au {validUntil || "—"}</p>
          </div>
        </div>
        <div className="grid gap-6 py-6 md:grid-cols-2">
          <div><h3 className="font-serif text-lg text-primary">Client</h3><p className="text-sm text-muted-foreground">{client || "—"}<br />{clientAddress || "Adresse à compléter"}<br />Qualité : {quality === "conso" ? "consommateur" : "professionnel"}</p></div>
          <div><h3 className="font-serif text-lg text-primary">Conclusion</h3><p className="text-sm text-muted-foreground">{mode === "distance" ? "À distance" : mode === "hors" ? "Hors établissement" : "Dans l’établissement"}<br />{(quality === "conso" && mode !== "etablissement") ? "Droit de rétractation de 14 jours applicable." : "Les mentions protectrices sont adaptées à la qualité du client."}</p></div>
        </div>
        <h3 className="font-serif text-lg text-primary">Prestation</h3>
        <p className="mt-2 text-sm text-muted-foreground">{objet || prestation.objet}</p>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm"><thead><tr className="border-b border-border text-muted-foreground"><th className="py-3">Désignation</th><th className="py-3 text-right">Montant</th></tr></thead><tbody><tr className="border-b border-border/60"><td className="py-4">{prestation.titre}</td><td className="py-4 text-right">{money(total)}</td></tr><tr className="font-semibold"><td className="py-4">Total TTC</td><td className="py-4 text-right text-primary">{money(total)}</td></tr></tbody></table>
        </div>
        <div className="mt-8 space-y-3 text-xs leading-5 text-muted-foreground">
          <p>{legalKitConfig.entreprise.tva}</p>
          <p>Devis gratuit sauf mention contraire. Paiement sous {legalKitConfig.devis.delaiPaiementJours} jours à compter de la facture. Toute prestation supplémentaire nécessite un accord écrit.</p>
          {quality === "conso" && mode !== "etablissement" && <p>Le client consommateur dispose d’un droit de rétractation de 14 jours. L’exécution anticipée d’un service nécessite sa demande expresse.</p>}
          <p>Réclamation : {legalKitConfig.contacts.reclamation}. Médiateur : {legalKitConfig.mediateur.nom}.</p>
        </div>
      </article>
    </div>
  );
}

function ContratDocument() {
  return (
    <article className="border border-border bg-card p-6 shadow-sm md:p-10">
      <div className="border-b border-border pb-6"><p className="text-xs uppercase tracking-[0.22em] text-primary">NovaLuth</p><h2 className="mt-2 text-3xl text-foreground">Contrat de prestation de services</h2><p className="mt-2 text-sm text-muted-foreground">Version à compléter — le devis accepté précise le prix, le périmètre et les dates.</p></div>
      <div className="mt-8 space-y-8">
        {articleContents.map(([title, body], index) => (
          <section key={title} className={index === 7 || index === 15 || index === 16 ? "border border-primary/30 bg-primary/5 p-5" : ""}>
            <h3 className="font-serif text-xl text-primary">Article {index + 1}. {title}</h3>
            <p className="mt-3 leading-7 text-muted-foreground">{body}</p>
            {index === 7 && <p className="mt-3 text-sm text-muted-foreground">Rétractation : {legalKitConfig.entreprise.email} — {legalKitConfig.entreprise.adresse}</p>}
            {index === 9 && <p className="mt-3 text-sm text-muted-foreground">Assurance : {legalKitConfig.assurance.assureur}, contrat {legalKitConfig.assurance.numeroContrat}, zone {legalKitConfig.assurance.zone}.</p>}
            {index === 13 && <p className="mt-3 text-sm text-muted-foreground">Contact RGPD : {legalKitConfig.contacts.rgpd}. Réclamation possible auprès de la CNIL.</p>}
            {index === 15 && <p className="mt-3 text-sm text-muted-foreground">Médiateur : {legalKitConfig.mediateur.nom} — {legalKitConfig.mediateur.adresse} — {legalKitConfig.mediateur.site}</p>}
          </section>
        ))}
      </div>
      <div className="mt-10 grid gap-6 border-t border-border pt-8 md:grid-cols-2"><div><h3 className="font-serif text-lg text-primary">Le client</h3><p className="mt-8 text-sm text-muted-foreground">Fait à ……………………… le ……/……/…………<br /><br />Signature :</p></div><div><h3 className="font-serif text-lg text-primary">Le prestataire</h3><p className="mt-8 text-sm text-muted-foreground">{legalKitConfig.entreprise.representant}<br /><br />Signature et cachet :</p></div></div>
      <p className="mt-10 text-xs leading-5 text-muted-foreground">Modèle fourni à titre informatif. Il ne constitue pas un conseil juridique individualisé.</p>
    </article>
  );
}

function NoticeDocument() {
  return (
    <article className="border border-border bg-card p-6 shadow-sm md:p-10">
      <h2 className="text-3xl text-foreground">Notice explicative</h2>
      <p className="mt-3 max-w-3xl leading-7 text-muted-foreground">Cette notice explique les points à vérifier avant d’envoyer un devis ou de signer un contrat avec un consommateur. Elle complète les deux documents du kit et ne remplace pas une consultation juridique.</p>
      <div className="mt-8 overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr className="border-b border-border text-muted-foreground"><th className="py-3 pr-4">Clause</th><th className="py-3 pr-4">Base légale</th><th className="py-3 pr-4">Pourquoi</th><th className="py-3">Risque si elle manque</th></tr></thead><tbody>{noticeRows.map((row) => <tr key={row[0]} className="border-b border-border/60 align-top"><td className="py-4 pr-4 font-medium text-foreground">{row[0]}</td><td className="py-4 pr-4 text-muted-foreground">{row[1]}</td><td className="py-4 pr-4 text-muted-foreground">{row[2]}</td><td className="py-4 text-muted-foreground">{row[3]}</td></tr>)}</tbody></table></div>
      <div className="mt-10 grid gap-4 md:grid-cols-3"><div className="border border-primary/30 bg-primary/5 p-5"><h3 className="font-serif text-lg text-primary">Médiation</h3><p className="mt-2 text-sm text-muted-foreground">Adhérez réellement à un médiateur agréé et reportez ses coordonnées dans tous vos documents.</p></div><div className="border border-primary/30 bg-primary/5 p-5"><h3 className="font-serif text-lg text-primary">Rétractation</h3><p className="mt-2 text-sm text-muted-foreground">À distance ou hors établissement, recueillez une demande expresse avant toute exécution anticipée.</p></div><div className="border border-primary/30 bg-primary/5 p-5"><h3 className="font-serif text-lg text-primary">Équilibre</h3><p className="mt-2 text-sm text-muted-foreground">N’ajoutez ni modification unilatérale du prix, ni pénalité disproportionnée, ni limitation des garanties.</p></div></div>
      <div className="mt-10 border-t border-border pt-6 text-sm text-muted-foreground"><h3 className="font-serif text-lg text-primary">Sources officielles</h3><ul className="mt-3 space-y-2"><li><a className="text-primary underline" href="https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006069565/LEGISCTA000032221271/" target="_blank" rel="noopener">Garantie légale de conformité — Légifrance <ExternalLink className="inline h-3 w-3" /></a></li><li><a className="text-primary underline" href="https://www.economie.gouv.fr/mediation-conso/vous-etes-un-professionnel/vos-principales-obligations-0" target="_blank" rel="noopener">Médiation de la consommation — economie.gouv.fr <ExternalLink className="inline h-3 w-3" /></a></li><li><a className="text-primary underline" href="https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000032890812" target="_blank" rel="noopener">Clauses abusives — Légifrance <ExternalLink className="inline h-3 w-3" /></a></li></ul></div>
    </article>
  );
}

export function LegalKit({ document }: { document: LegalDocument }) {
  return (
    <div className="container mx-auto px-4 py-12 md:py-16">
      <div className="mx-auto max-w-6xl space-y-8">
        <LegalKitHeader document={document} />
        <LegalWarning />
        <LegalDocumentNav current={document} />
        {document === "devis" && <DevisDocument />}
        {document === "contrat" && <ContratDocument />}
        {document === "notice" && <NoticeDocument />}
        <p className="text-xs leading-5 text-muted-foreground print:mt-8">Modèles NovaLuth fournis à titre informatif. Faites-les valider par un professionnel du droit au regard de votre activité et de vos informations réelles.</p>
      </div>
    </div>
  );
}

export function LegalDevis() {
  return <LegalKit document="devis" />;
}

export function LegalContrat() {
  return <LegalKit document="contrat" />;
}

export function LegalNotice() {
  return <LegalKit document="notice" />;
}