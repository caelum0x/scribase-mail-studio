import { Button } from "@usesend/ui/src/button";
import { CodeBlock } from "@usesend/ui/src/code-block";
import { CodeBlockWithCopy } from "@usesend/ui/src/code-block-with-copy";
import { LangToggle } from "./CodeLangToggle";

const TS_CODE = `const res = await fetch("https://mail.scribase.com/api/v1/emails", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: \`Bearer \${process.env.SCRIBASE_MAIL_API_KEY}\`,
  },
  body: JSON.stringify({
    to: "hello@acme.com",
    from: "hello@company.com",
    subject: "Welcome",
    html: "<p>Thanks for signing up.</p>",
  }),
});

console.log(await res.json()); // { emailId: "..." }`;

const PY_CODE = `import os
import requests

res = requests.post(
    "https://mail.scribase.com/api/v1/emails",
    headers={"Authorization": f"Bearer {os.environ['SCRIBASE_MAIL_API_KEY']}"},
    json={
        "to": "hello@acme.com",
        "from": "hello@company.com",
        "subject": "Welcome",
        "html": "<p>Thanks for signing up.</p>",
    },
)

print(res.json())`;

const GO_CODE = `package main

import (
    "fmt"
    "io"
    "net/http"
    "os"
    "strings"
)

func main() {
    url := "https://mail.scribase.com/api/v1/emails"

    payload := strings.NewReader(\`{"to":"hello@acme.com","from":"hello@company.com","subject":"Welcome","html":"<p>Thanks for signing up.</p>"}\`)

    req, _ := http.NewRequest("POST", url, payload)
    req.Header.Add("Content-Type", "application/json")
    req.Header.Add("Authorization", "Bearer "+os.Getenv("SCRIBASE_MAIL_API_KEY"))

    res, _ := http.DefaultClient.Do(req)
    defer res.Body.Close()

    body, _ := io.ReadAll(res.Body)
    fmt.Println(res)
    fmt.Println(string(body))
}`;

const PHP_CODE = `<?php

$ch = curl_init('https://mail.scribase.com/api/v1/emails');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    'Content-Type: application/json',
    'Authorization: Bearer ' . getenv('SCRIBASE_MAIL_API_KEY'),
  ],
  CURLOPT_POST => true,
  CURLOPT_POSTFIELDS => json_encode([
    'to' => 'hello@acme.com',
    'from' => 'hello@company.com',
    'subject' => 'Welcome',
    'html' => '<p>Thanks for signing up.</p>',
  ]),
]);

$response = curl_exec($ch);
if ($response === false) {
  echo 'cURL error: ' . curl_error($ch);
} else {
  echo $response;
}
curl_close($ch);`;

export function CodeExample() {
  const containerId = "code-example";
  const languages = [
    {
      key: "ts",
      label: "TypeScript",
      kind: "ts",
      shiki: "typescript" as const,
      code: TS_CODE,
    },
    {
      key: "py",
      label: "Python",
      kind: "py",
      shiki: "python" as const,
      code: PY_CODE,
    },
    {
      key: "go",
      label: "Go",
      kind: "go",
      shiki: "go" as const,
      code: GO_CODE,
    },
    {
      key: "php",
      label: "PHP",
      kind: "php",
      shiki: "php" as const,
      code: PHP_CODE,
    },
  ];

  return (
    <section className="py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="text-center">
          <div className="mb-2 text-sm uppercase tracking-wider text-primary">
            Developers
          </div>
          <p className="mt-1 text-xs sm:text-sm text-muted-foreground max-w-2xl mx-auto">
            Typed SDKs and simple APIs, so you can focus on product not
            plumbing.
          </p>
        </div>

        <div className="mt-8 overflow-hidden" id={containerId}>
          <div className="flex items-center gap-2 justify-center py-2 text-xs text-muted-foreground mb-4">
            <LangToggle
              containerId={containerId}
              defaultLang="ts"
              languages={languages.map(({ key, label, kind }) => ({
                key,
                label,
                kind,
              }))}
            />
          </div>
          <div className="rounded-[18px] bg-primary/20 p-1">
            <div className="rounded-[14px] bg-primary/20 p-0.5 shadow-sm">
              <div className="bg-background rounded-xl overflow-hidden">
                {languages.map((l, idx) => (
                  <div
                    key={l.key}
                    data-lang-slot={l.key}
                    className={idx === 0 ? "block" : "hidden"}
                  >
                    {/* Cast to any to align with shiki BundledLanguage without importing types here */}
                    <CodeBlockWithCopy code={l.code}>
                      <CodeBlock
                        lang={l.shiki as any}
                        className="p-4 rounded-[10px]"
                      >
                        {l.code}
                      </CodeBlock>
                    </CodeBlockWithCopy>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="sr-only" aria-live="polite">
            Language example toggled
          </div>
        </div>

        <div className="mt-6 flex items-center justify-center gap-3">
          <Button size="lg" className="px-6">
            <a
              href="https://scribase.com/docs/mail"
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the docs
            </a>
          </Button>
        </div>
      </div>
    </section>
  );
}

export default CodeExample;
