import { asArray, asNumber, asObject, asString, parse } from "./json.ts";

/** A GPU Vast.ai rents out now, as `ferry gpus --json` lists it, cheapest first. */
export interface Offer {
  id: number;
  gpu: string;
  count: number;
  /** GB per GPU. */
  memory: number;
  /** Dollars per hour, its disk included. */
  price: number;
  reliability: number;
  tier: string;
  place: string;
  /** Mb/s. */
  download: number;
  /** Dollars per GB sent to it. */
  upCost: number;
}

/** What asking Ferry for the GPUs it can rent came to; `understood` is how Ferry read the search words. */
export type OffersAnswer =
  | { kind: "offers"; offers: Offer[]; understood: string }
  | { kind: "old-ferry" } // older than 0.2, which rents
  | { kind: "error"; message: string };

/** Search words for `ferry gpus`, shown in the offer list. */
export const SEARCH_HINT = "Search: 4090, a100, europe, us, <0.5 (per hour), 24gb, 2x, datacenter";

/** Reads the outcome of `ferry gpus --json [words]`. */
export function offersAnswer(ok: boolean, stdout: string, stderr: string): OffersAnswer {
  if (!ok) {
    if (/invalid choice: '(gpus|login)'/.test(stderr)) return { kind: "old-ferry" };
    const lines = stderr.trim().split(/\r?\n/);
    return { kind: "error", message: lines[lines.length - 1]?.replace(/^ferry: /, "") || "Ferry did not answer." };
  }
  try {
    const answer = asObject(parse(stdout));
    const offers = asArray(answer.offers).map(asObject).flatMap((o) => {
      const id = asNumber(o.id);
      const price = asNumber(o.price);
      const gpu = asString(o.gpu);
      return id !== undefined && price !== undefined && gpu ? [{
        id, gpu, price,
        count: asNumber(o.count) ?? 1,
        memory: asNumber(o.memory) ?? 0,
        reliability: asNumber(o.reliability) ?? 0,
        tier: asString(o.tier) ?? "?",
        place: asString(o.place) ?? "?",
        download: asNumber(o.download) ?? 0,
        upCost: asNumber(o.up_cost) ?? 0,
      }] : [];
    });
    return { kind: "offers", offers, understood: asString(answer.understood) ?? "any GPU" };
  } catch {
    return { kind: "error", message: "Ferry's list of GPUs could not be read." };
  }
}

/** The shortest time Ferry rents a machine for: it can take five minutes to start. */
export const MIN_SECONDS = 600;

/** Seconds in 2h, 90m, 1h30m or 1.5h, read as Ferry reads --for; undefined when Ferry would refuse it. */
export function parseDuration(text: string): number | undefined {
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m)?$/.exec(text.trim().toLowerCase());
  if (!match || (!match[1] && !match[2])) return undefined;
  const seconds = Math.round(Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60);
  return seconds >= MIN_SECONDS ? seconds : undefined;
}

/** "$0.13", or "under a cent", as Ferry says it. */
export function dollars(amount: number): string {
  return amount < 0.01 ? "under a cent" : `$${amount.toFixed(2)}`;
}

/** The most renting the offer for `seconds` can cost, bandwidth aside. Ferry falls back only to offers at its price or less. */
export function mostCost(offer: Offer, seconds: number): number {
  return offer.price * seconds / 3600;
}

/** The times to pick from for how long a rented machine may run, as Ferry's --for reads them. */
export const TIMES: [value: string, label: string][] = [
  ["30m", "30 minutes"], ["1h", "1 hour"], ["2h", "2 hours"], ["4h", "4 hours"], ["8h", "8 hours"], ["12h", "12 hours"], ["24h", "24 hours"],
];

/** "at most $0.20, plus $0.0065 per GB you send it", or "..., data free". */
export function timeCost(offer: Offer, seconds: number): string {
  const data = offer.upCost ? `plus $${offer.upCost.toFixed(4)} per GB you send it` : "data free";
  return `at most ${dollars(mostCost(offer, seconds))}, ${data}`;
}

/** How an offer reads in a list: "RTX 3060", "$0.064/h, Quebec, CA", "12 GB, 99.6% reliable, verified host, 1465 Mb/s down". */
export function offerText(offer: Offer): { label: string; description: string; detail: string } {
  return {
    label: offer.count > 1 ? `${offer.count}x ${offer.gpu}` : offer.gpu,
    description: `$${offer.price.toFixed(3)}/h, ${offer.place}`,
    detail: `${offer.memory} GB, ${(offer.reliability * 100).toFixed(1)}% reliable, ${offer.tier} host, ${Math.round(offer.download)} Mb/s down`,
  };
}
