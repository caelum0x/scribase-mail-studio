import { TopNav } from "~/components/TopNav";
import { SiteFooter } from "~/components/SiteFooter";

interface LegalPageProps {
  title: string;
  intro: string;
  sections: { heading: string; body: string }[];
  canonicalUrl: string;
}

export function LegalPage({
  title,
  intro,
  sections,
  canonicalUrl,
}: LegalPageProps) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <TopNav />
      <div className="mx-auto max-w-3xl px-6 py-16">
        <h1 className="mb-6 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mb-8 text-muted-foreground">{intro}</p>
        {sections.map((section) => (
          <section key={section.heading} className="mb-8 space-y-3">
            <h2 className="text-xl font-medium">{section.heading}</h2>
            <p className="text-muted-foreground">{section.body}</p>
          </section>
        ))}
        <p className="text-sm text-muted-foreground">
          The full, current version is published at{" "}
          <a
            href={canonicalUrl}
            className="text-foreground underline-offset-4 hover:underline"
          >
            {canonicalUrl}
          </a>
          .
        </p>
      </div>
      <SiteFooter />
    </main>
  );
}
