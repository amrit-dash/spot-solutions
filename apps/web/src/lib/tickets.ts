// Ticket sales (packages/shared/src/tickets.ts): live accounts, listings and links, plus the actions the Tickets page
// and the show strip use. Logins are sealed in the browser to the worker's key before they leave the page.
import { useMemo } from "react";
import { deleteDoc, setDoc } from "firebase/firestore";
import { linkId, linkedShowIds, sealTo, type TicketAccount, type TicketLink, type TicketListing, type TicketPlatform, type TicketPublicKey } from "@spot/shared";
import { runCommand, useCollection, userDoc } from "./data";

export function useTickets(uid: string | undefined) {
  const accounts = useCollection<TicketAccount>(uid, "ticketAccounts");
  const listings = useCollection<TicketListing>(uid, "ticketListings");
  const links = useCollection<TicketLink & { id: string }>(uid, "ticketLinks");
  const linkMap = useMemo(() => new Map(links.data.map((l) => [linkId(l.platform, l.accountId, l.listingId), l])), [links.data]);
  return { accounts: accounts.data, listings: listings.data, links: linkMap, loading: accounts.loading || listings.loading || links.loading };
}

export interface ConnectResult {
  accountId: string;
  status: "connected" | "needs_otp" | "needs_login";
  message?: string;
  listings?: number;
}

/** Seal the login to the worker's key (fetching or creating it first), then hand it over. */
export async function connectAccount(uid: string, input: { platform: TicketPlatform; label: string; login: string; password: string; accountId?: string }): Promise<ConnectResult> {
  const key = await runCommand<TicketPublicKey>(uid, "ticket_key", {}, 60_000);
  const sealed = await sealTo(key.x25519, JSON.stringify({ login: input.login, password: input.password }));
  return runCommand<ConnectResult>(uid, "ticket_connect", { sealed, platform: input.platform, label: input.label, ...(input.accountId ? { accountId: input.accountId } : {}) }, 3 * 60_000);
}

export const sendOtp = (uid: string, accountId: string, otp: string) => runCommand<ConnectResult>(uid, "ticket_otp", { accountId, otp }, 3 * 60_000);
export const disconnectAccount = (uid: string, accountId: string) => runCommand(uid, "ticket_disconnect", { accountId }, 2 * 60_000);
export const syncNow = (uid: string, accountId?: string) => runCommand<{ accounts: number; listings: number }>(uid, "ticket_sync", accountId ? { accountId } : {}, 5 * 60_000);

/** The shows a whole listing feeds (each date goes to the one running that night); [] unlinks it. Keeps date exceptions. */
export async function linkListing(uid: string, l: Pick<TicketListing, "platform" | "accountId" | "listingId">, showIds: string[], current?: TicketLink) {
  const id = linkId(l.platform, l.accountId, l.listingId);
  const overrides = current?.sessionOverrides ?? {};
  if (!showIds.length && !Object.keys(overrides).length) return deleteDoc(userDoc(uid, "ticketLinks", id));
  return setDoc(userDoc(uid, "ticketLinks", id), { platform: l.platform, accountId: l.accountId, listingId: l.listingId, showId: showIds[0] ?? null, showIds, sessionOverrides: overrides, updatedAt: Date.now() } satisfies TicketLink);
}

/** One session to another show, out (null), or back to the listing's show (undefined). */
export async function overrideSession(uid: string, l: Pick<TicketListing, "platform" | "accountId" | "listingId" | "sessionId">, value: string | null | undefined, current?: TicketLink) {
  const overrides = { ...(current?.sessionOverrides ?? {}) };
  if (value === undefined) delete overrides[l.sessionId];
  else overrides[l.sessionId] = value;
  const id = linkId(l.platform, l.accountId, l.listingId);
  const showIds = linkedShowIds(current);
  return setDoc(userDoc(uid, "ticketLinks", id), { platform: l.platform, accountId: l.accountId, listingId: l.listingId, showId: showIds[0] ?? null, showIds, sessionOverrides: overrides, updatedAt: Date.now() } satisfies TicketLink);
}
