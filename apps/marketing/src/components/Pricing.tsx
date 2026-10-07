import {
  PRICING_PLAN_ORDER,
  PRICING_PLANS,
} from "@usesend/lib/src/constants/pricing";
import { APP_URL } from "~/lib/site";

/** Plans and prices come from the shared pricing config used by the app. */
export function Pricing() {
  return (
    <section id="pricing" className="py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-6">
        <div className="text-center text-sm uppercase tracking-wider text-muted-foreground">
          Pricing
        </div>
        <h2 className="mt-3 text-center text-2xl font-semibold tracking-tight sm:text-3xl">
          Start free. Pay as you grow.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-sm text-muted-foreground sm:text-base">
          Every plan includes the API, SMTP relay, campaigns, webhooks and
          tracking. Paid plans bill extra email per 1,000 instead of stopping
          your sends.
        </p>

        <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
          {PRICING_PLAN_ORDER.map((id) => {
            const plan = PRICING_PLANS[id];
            const highlighted = id === "PRO";
            return (
              <div
                key={id}
                className={`flex flex-col rounded-2xl border p-6 ${
                  highlighted
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-foreground"
                }`}
              >
                <div className="text-base font-medium">{plan.name}</div>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="font-mono text-4xl font-semibold">
                    ${plan.priceUsdMonthly}
                  </span>
                  <span
                    className={`text-sm ${highlighted ? "opacity-70" : "text-muted-foreground"}`}
                  >
                    / month
                  </span>
                </div>
                <p
                  className={`mt-2 text-sm ${highlighted ? "opacity-70" : "text-muted-foreground"}`}
                >
                  {plan.description}
                </p>
                <ul className="mt-6 flex-1 space-y-2 text-sm">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <span aria-hidden className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-current" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <a
                  href={APP_URL}
                  className={`mt-8 inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition-opacity hover:opacity-90 ${
                    highlighted
                      ? "bg-background text-foreground"
                      : "bg-foreground text-background"
                  }`}
                >
                  {plan.priceUsdMonthly === 0 ? "Start free" : `Choose ${plan.name}`}
                </a>
              </div>
            );
          })}
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Prices in USD, billed monthly. Payments are processed by Dodo
          Payments, our merchant of record; taxes are calculated at checkout.
        </p>
      </div>
    </section>
  );
}
