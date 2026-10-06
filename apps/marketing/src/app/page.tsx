import Link from "next/link";
import { Button } from "@usesend/ui/src/button";
import { SiteFooter } from "~/components/SiteFooter";
import { TopNav } from "~/components/TopNav";
import { FeatureCardPlain } from "~/components/FeatureCardPlain";
import CodeExample from "~/components/CodeExample";
import {
  APP_URL,
  DOCS_URL,
  SCRIBASE_URL,
  SOURCE_CODE_URL,
  UPSTREAM_URL,
} from "~/lib/site";

export default function Page() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <TopNav />
      <Hero />
      <Features />
      <CodeExample />
      <PartOfScribase />
      <SiteFooter />
    </main>
  );
}

function Hero() {
  return (
    <section>
      <div className="mx-auto max-w-4xl px-6 py-20 text-center sm:py-28">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-5xl">
          Email for your app, in one API call
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base text-muted-foreground sm:text-lg">
          Send transactional and marketing email from a calm dashboard and a
          familiar REST API. Verified domains, campaigns, contacts and webhooks
          included.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button size="lg" className="px-6" asChild>
            <a href={APP_URL}>Start sending</a>
          </Button>
          <Button size="lg" variant="outline" className="px-6" asChild>
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
              Read the docs
            </a>
          </Button>
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Open source under AGPL-3.0. Self-host or use it inside Scribase.
        </p>
      </div>
    </section>
  );
}

const FEATURES = [
  {
    title: "Familiar send API",
    content:
      "POST /api/v1/emails with to, from, subject and html. SDKs for TypeScript, Python and Go, plus an SMTP relay for any framework.",
  },
  {
    title: "Domains in minutes",
    content:
      "Add a domain, publish one DKIM CNAME and one SPF record, and start sending. Verification is checked for you in the background.",
  },
  {
    title: "Campaigns and contacts",
    content:
      "Contact books, double opt-in, a visual editor and scheduled campaigns with one-click unsubscribe.",
  },
  {
    title: "Opens and clicks",
    content:
      "First-party open and click tracking with signed links, per domain. Turn it on or off at any time.",
  },
  {
    title: "Bounces and complaints",
    content:
      "Hard bounces and complaints are added to your suppression list automatically, so you never mail them twice.",
  },
  {
    title: "Webhooks",
    content:
      "Signed webhooks for sent, opened, clicked, bounced, complained and domain events, with retries and a delivery log.",
  },
];

function Features() {
  return (
    <section id="features" className="py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="text-center text-sm uppercase tracking-wider text-muted-foreground">
          What you get
        </div>
        <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <FeatureCardPlain
              key={feature.title}
              title={feature.title}
              content={feature.content}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function PartOfScribase() {
  return (
    <section id="about" className="py-16 sm:py-20">
      <div className="mx-auto max-w-3xl space-y-4 px-6 text-sm text-muted-foreground sm:text-base">
        <h2 className="text-center text-xl font-semibold tracking-tight text-foreground">
          Part of Scribase
        </h2>
        <p>
          Scribase Mail is the email layer of{" "}
          <a
            href={SCRIBASE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline-offset-4 hover:underline"
          >
            Scribase
          </a>
          : one place for your database, auth and the email your app sends. Mail
          is delivered through Oracle Cloud Email Delivery.
        </p>
        <p>
          It is built on the open source{" "}
          <a
            href={UPSTREAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline-offset-4 hover:underline"
          >
            useSend
          </a>{" "}
          project and released under the same AGPL-3.0 license. The full{" "}
          <Link
            href={SOURCE_CODE_URL}
            className="text-foreground underline-offset-4 hover:underline"
          >
            source code
          </Link>{" "}
          is available.
        </p>
      </div>
    </section>
  );
}
