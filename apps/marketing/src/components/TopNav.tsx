"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@usesend/ui/src/button";
import { APP_URL, DOCS_URL, SOURCE_CODE_URL } from "~/lib/site";

const NAV_LINKS = [
  { href: "/#features", label: "Features", external: false },
  { href: DOCS_URL, label: "Docs", external: true },
  { href: SOURCE_CODE_URL, label: "Source", external: true },
];

export function TopNav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/70 py-4 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 text-sm">
        <Link href="/" className="group flex items-center gap-2">
          <Image
            src="/logo-squircle.png"
            alt="Scribase Mail"
            width={24}
            height={24}
          />
          <span className="text-[16px] font-medium tracking-tight group-hover:opacity-90">
            Scribase Mail
          </span>
        </Link>

        <nav className="hidden items-center gap-5 text-muted-foreground sm:flex">
          {NAV_LINKS.map((link) =>
            link.external ? (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground"
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.label}
                href={link.href}
                className="hover:text-foreground"
              >
                {link.label}
              </Link>
            ),
          )}
          <Button size="sm" className="ml-2" asChild>
            <a href={APP_URL}>Start sending</a>
          </Button>
        </nav>

        <button
          aria-label={open ? "Close menu" : "Open menu"}
          className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground sm:hidden"
          onClick={() => setOpen((value) => !value)}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-6 w-6"
            aria-hidden="true"
          >
            {open ? (
              <path
                d="M6 18 18 6M6 6l12 12"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <path
                d="M3 6h18M3 12h18M3 18h18"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
        </button>
      </div>

      {open ? (
        <div className="border-t border-border/60 bg-background/90 backdrop-blur-xl sm:hidden">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-3">
            {NAV_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="py-2 text-muted-foreground hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                {link.label}
              </a>
            ))}
            <Button className="mt-2 w-full" asChild>
              <a href={APP_URL}>Start sending</a>
            </Button>
          </div>
        </div>
      ) : null}
    </header>
  );
}
