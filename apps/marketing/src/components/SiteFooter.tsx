import Image from "next/image";
import Link from "next/link";
import {
  APP_URL,
  CONTACT_EMAIL,
  DOCS_URL,
  SCRIBASE_URL,
  SOURCE_CODE_URL,
  UPSTREAM_URL,
} from "~/lib/site";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { label: "Dashboard", href: APP_URL },
      { label: "Docs", href: DOCS_URL },
      { label: "Scribase", href: SCRIBASE_URL },
    ],
  },
  {
    title: "Open source",
    links: [
      { label: "Source code", href: SOURCE_CODE_URL },
      { label: "Built on useSend", href: UPSTREAM_URL },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Contact", href: `mailto:${CONTACT_EMAIL}` },
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border/60 py-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 sm:flex-row sm:items-start">
        <div className="flex items-center gap-2 sm:w-56">
          <Image
            src="/logo-squircle.png"
            alt="Scribase Mail"
            width={24}
            height={24}
          />
          <span className="font-medium tracking-tight">Scribase Mail</span>
        </div>
        <div className="grid grid-cols-2 gap-x-12 gap-y-6 text-sm sm:ml-auto sm:grid-cols-3">
          {COLUMNS.map((column) => (
            <div key={column.title}>
              <div className="mb-2 text-xs uppercase tracking-wider">
                {column.title}
              </div>
              <ul className="space-y-2 text-muted-foreground">
                {column.links.map((link) => (
                  <li key={link.label}>
                    {link.href.startsWith("/") ? (
                      <Link
                        href={link.href}
                        className="text-xs hover:text-foreground"
                      >
                        {link.label}
                      </Link>
                    ) : (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs hover:text-foreground"
                      >
                        {link.label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <p className="mx-auto mt-10 max-w-6xl px-6 text-xs text-muted-foreground">
        Scribase Mail is free software under the GNU AGPL-3.0, derived from
        useSend. Part of Scribase, the open source Postgres backend platform.
      </p>
    </footer>
  );
}
