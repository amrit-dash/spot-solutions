// Tickets: connected organizer accounts (ours and producers'), every listing they have, and which show each belongs to.
// Counts come from the server (apps/worker/src/tickets) and always show how old they are.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  DAY_SHORT,
  TICKET_PLATFORM_NAMES,
  TICKET_STALE_MS,
  formatTime,
  linkedShowIds,
  localNow,
  showTicketTotals,
  spotDateLabel,
  ticketMismatch,
  ticketShowFor,
  type Show,
  type TicketAccount,
  type TicketLink,
  type TicketListing,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { timeAgo, useNow } from "../lib/data";
import { connectAccount, disconnectAccount, linkListing, overrideSession, sendOtp, syncNow, useTickets } from "../lib/tickets";
import { Button, Chip, ConfirmDialog, Empty, Field, IconButton, Info, Menu, MenuItem, PageHeader, SearchSelect, Sheet, Spinner, TextInput, cx } from "@spot/ui";
import { IconAdd, IconCheck, IconClose, IconMenuDots, IconRefresh, IconTicket, IconWarn } from "@spot/ui";

const STATUS_CHIP: Record<TicketAccount["status"], { label: string; tone: "success" | "error" | "primary" | "neutral" }> = {
  connected: { label: "Connected", tone: "success" },
  connecting: { label: "Connecting…", tone: "neutral" },
  needs_otp: { label: "Needs OTP", tone: "error" },
  needs_login: { label: "Connect again", tone: "error" },
  error: { label: "Sync failed", tone: "error" },
};

function Synced({ at, now }: { at: number | null | undefined; now: number }) {
  if (!at) return <span className="type-body-s text-on-surface-variant">Not synced yet</span>;
  const stale = now - at > TICKET_STALE_MS;
  return (
    <span className={cx("inline-flex items-center gap-1 type-body-s", stale ? "text-error" : "text-on-surface-variant")} title={new Date(at).toLocaleString()}>
      {stale && <IconWarn className="icon size-4" />}
      Synced {timeAgo(at, now)}
      {stale && " · may be out of date"}
    </span>
  );
}

function ConnectSheet({ open, onClose, reconnect }: { open: boolean; onClose: () => void; reconnect?: TicketAccount | null }) {
  const { uid } = useApp();
  const [label, setLabel] = useState(reconnect?.label ?? "");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await connectAccount(uid, { label: label.trim() || "BookMyShow account", login, password, accountId: reconnect?.id });
      if (r.status === "connected") toast.success(`Connected. ${r.listings ?? 0} show date${r.listings === 1 ? "" : "s"} found.`);
      else if (r.status === "needs_otp") toast.message("BookMyShow sent an OTP. Enter it on the account card.");
      else toast.error(r.message ?? "BookMyShow refused the login.");
      if (r.status !== "needs_login") {
        setPassword("");
        onClose();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={reconnect ? `Reconnect ${reconnect.label}` : "Connect BookMyShow"}
      footer={
        <Button loading={busy} disabled={!login.trim() || !password} onClick={() => void submit()}>
          Connect
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="type-body-m text-on-surface-variant">
          The HostMyShow organizer login (diy.hostmyshow.com). It can be yours or a producer's whose shows you run: they can type it here themselves. The password is encrypted on this device before it's sent, and only your server can read it, to keep the session alive. Disconnect removes it.
        </p>
        <Field label="Whose account" hint="Shown on the card, e.g. “Us” or “Rahul's productions”.">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Us" maxLength={60} />
        </Field>
        <Field label="Login" hint="Email or username used on HostMyShow.">
          <TextInput value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </Field>
        <Field label="Password">
          <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" onKeyDown={(e) => e.key === "Enter" && login.trim() && password && void submit()} />
        </Field>
      </div>
    </Sheet>
  );
}

function AccountCard({ acc, listingCount, now, onReconnect }: { acc: TicketAccount; listingCount: number; now: number; onReconnect: () => void }) {
  const { uid } = useApp();
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState<"otp" | "sync" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const chip = STATUS_CHIP[acc.status];
  const run = async (what: "otp" | "sync") => {
    setBusy(what);
    try {
      if (what === "otp") {
        const r = await sendOtp(uid, acc.id, otp);
        if (r.status === "connected") {
          toast.success(`${acc.label} connected.`);
          setOtp("");
        } else toast.error(r.message ?? "That OTP didn't work.");
      } else {
        const r = await syncNow(uid, acc.id);
        toast.success(`Synced ${r.listings} show date${r.listings === 1 ? "" : "s"}.`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="flex flex-col gap-3 rounded-lg bg-surface-container p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <IconTicket className="icon size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate type-title-m">{acc.label}</span>
            <Chip tone={chip.tone}>{chip.label}</Chip>
          </span>
          <span className="block truncate type-body-s text-on-surface-variant">
            {TICKET_PLATFORM_NAMES[acc.platform]} · {acc.loginHint} · {listingCount} live date{listingCount === 1 ? "" : "s"}
          </span>
          <Synced at={acc.lastSyncedAt} now={now} />
        </span>
        <Menu trigger={(open) => <IconButton icon={IconMenuDots} label={`More for ${acc.label}`} onClick={open} />} align="right">
          {(close) => (
            <>
              <MenuItem onClick={() => (close(), void run("sync"))} disabled={acc.status !== "connected" && acc.status !== "error"}>Sync now</MenuItem>
              <MenuItem onClick={() => (close(), onReconnect())}>Reconnect</MenuItem>
              <MenuItem onClick={() => (close(), setConfirm(true))}>Disconnect</MenuItem>
            </>
          )}
        </Menu>
      </div>
      {acc.statusText && <p className={cx("type-body-s", acc.status === "connected" ? "text-on-surface-variant" : "text-error")}>{acc.statusText}</p>}
      {acc.lastError && acc.status !== "needs_otp" && <p className="type-body-s text-error">Last sync: {acc.lastError}</p>}
      {acc.status === "needs_otp" && (
        <div className="flex gap-2">
          <TextInput value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 8))} inputMode="numeric" autoComplete="one-time-code" placeholder="OTP" className="min-w-0 flex-1" onKeyDown={(e) => e.key === "Enter" && otp.length >= 4 && void run("otp")} />
          <Button loading={busy === "otp"} disabled={otp.length < 4} onClick={() => void run("otp")}>
            Verify
          </Button>
        </div>
      )}
      {acc.status === "needs_login" && (
        <Button variant="tonal" onClick={onReconnect}>
          Connect again
        </Button>
      )}
      {busy === "sync" && (
        <span className="flex items-center gap-2 type-body-s text-on-surface-variant">
          <Spinner className="size-4" /> Syncing…
        </span>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Disconnect ${acc.label}?`}
        confirmLabel="Disconnect"
        onConfirm={async () => {
          try {
            await disconnectAccount(uid, acc.id);
            toast.success(`${acc.label} disconnected. Its saved login and listings are gone.`);
          } catch (e) {
            toast.error((e as Error).message);
          }
        }}
      >
        Its saved login is deleted from your server, and its listings and show links are removed. You can connect it again any time.
      </ConfirmDialog>
    </li>
  );
}

const showOption = (s: Show) => ({ value: s.id, label: s.name, hint: `${DAY_SHORT[s.weekday]} · ${formatTime(s.startTime)}${s.active ? "" : " · off"}` });

function ListingGroup({ rows, account, link, shows, now }: { rows: TicketListing[]; account?: TicketAccount; link?: TicketLink; shows: Show[]; now: number }) {
  const { uid } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const first = rows[0];
  const links = useMemo(() => new Map(link ? [[`${first.platform}:${first.accountId}:${first.listingId}`, link]] : []), [link, first]);
  const options = useMemo(() => shows.map(showOption), [shows]);
  const linked = linkedShowIds(link);
  const save = (p: Promise<unknown>) => void p.catch((e) => toast.error((e as Error).message));
  return (
    <li className="rounded-lg bg-surface-container p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="block type-title-s">{first.eventName}</span>
          <span className="block type-body-s text-on-surface-variant">
            {account?.label ?? "Removed account"} · {TICKET_PLATFORM_NAMES[first.platform]} · {first.venue ?? "Venue not given"}
            {first.publicUrl && (
              <>
                {" · "}
                <a href={first.publicUrl} target="_blank" rel="noreferrer" className="text-primary underline">
                  Public page
                </a>
              </>
            )}
          </span>
        </span>
        <SearchSelect value="" onChange={(v) => v && !linked.includes(v) && save(linkListing(uid, first, [...linked, v], link))} options={options.filter((o) => !linked.includes(o.value))} label={`Add a show for ${first.eventName}`} placeholder={linked.length ? "Add another show…" : "Belongs to show…"} wrapperClassName="w-full sm:w-64" />
      </div>
      {linked.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {linked.map((id) => {
            const s = shows.find((x) => x.id === id);
            return (
              <span key={id} className="inline-flex items-center gap-1 rounded-full bg-secondary-container py-1 pr-1 pl-3 type-label-l text-on-secondary-container">
                {s ? `${s.name} · ${DAY_SHORT[s.weekday]}` : "Deleted show"}
                <IconButton icon={IconClose} label={`Unlink ${s?.name ?? "this show"}`} onClick={() => save(linkListing(uid, first, linked.filter((x) => x !== id), link))} className="size-7" />
              </span>
            );
          })}
          {linked.length > 1 && <span className="type-body-s text-on-surface-variant">Each date counts for the show running that night.</span>}
        </div>
      )}
      <ul className="mt-3 divide-y divide-outline-variant">
        {rows.map((r) => {
          const showId = ticketShowFor(r, links, shows);
          const mismatch = ticketMismatch(r, links, shows);
          const overridden = link?.sessionOverrides && r.sessionId in link.sessionOverrides;
          const show = shows.find((s) => s.id === showId);
          return (
            <li key={r.key} className="py-2">
              <div className="flex items-center gap-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(open === r.key ? null : r.key)} aria-expanded={open === r.key}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="type-title-s tabular-nums">{spotDateLabel(r.showDate)} · {formatTime(r.showTime)}</span>
                    <span className="type-title-s tabular-nums">
                      {r.sold}/{r.capacity} sold
                    </span>
                    {r.state === "ended" && <Chip>Ended</Chip>}
                    {mismatch === "not_show_day" && <Chip tone="error" title="This date isn't a night of the linked show, so it's not counted there. Pick another show for this date, or leave it out.">Not {show?.name ?? "the show"}'s night</Chip>}
                    {mismatch === "no_show" && <Chip tone="error">Linked show was deleted</Chip>}
                    {overridden && <Chip tone="tertiary">{showId ? `→ ${show?.name ?? "other show"}` : "Left out"}</Chip>}
                  </span>
                  <Synced at={r.syncedAt} now={now} />
                </button>
                <Menu trigger={(o) => <IconButton icon={IconMenuDots} label={`Options for ${spotDateLabel(r.showDate)}`} onClick={o} />} align="right">
                  {(close) => (
                    <>
                      {overridden && <MenuItem onClick={() => (close(), save(overrideSession(uid, r, undefined, link)))}>Follow the listing's show</MenuItem>}
                      {shows.filter((s) => s.id !== showId).map((s) => (
                        <MenuItem key={s.id} onClick={() => (close(), save(overrideSession(uid, r, s.id, link)))} hint={`${DAY_SHORT[s.weekday]} ${formatTime(s.startTime)}`}>
                          Count for {s.name}
                        </MenuItem>
                      ))}
                      {showId && <MenuItem onClick={() => (close(), save(overrideSession(uid, r, null, link)))}>Leave this date out</MenuItem>}
                    </>
                  )}
                </Menu>
              </div>
              {open === r.key && (
                <div className="mt-2 rounded-md bg-surface-low p-3">
                  {r.bookings.length === 0 ? (
                    <p className="type-body-s text-on-surface-variant">No bookings yet.</p>
                  ) : (
                    <table className="w-full type-body-s tabular-nums">
                      <thead className="text-left text-on-surface-variant">
                        <tr>
                          <th className="py-1 font-medium">Booked</th>
                          <th className="py-1 font-medium">Qty</th>
                          <th className="py-1 font-medium">Category</th>
                          <th className="py-1 text-right font-medium">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.bookings.map((b) => (
                          <tr key={b.id} className={cx(b.status && b.status !== "Booked" && "text-on-surface-variant line-through")}>
                            <td className="py-1">{new Date(b.bookedAt).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                            <td className="py-1">{b.qty}</td>
                            <td className="py-1">{b.category ?? "—"}</td>
                            <td className="py-1 text-right">{b.amount != null ? `₹${b.amount}` : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {r.bookingsTruncated && <p className="mt-2 type-body-s text-on-surface-variant">BookMyShow only sends the latest bookings; the sold count above is still complete.</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/** Show nights coming up that have tickets linked: the number POCs and the curator look for. */
function ComingUp({ listings, links, shows, today, now, accounts }: { listings: TicketListing[]; links: Map<string, TicketLink>; shows: Show[]; today: string; now: number; accounts: Map<string, TicketAccount> }) {
  const nights = useMemo(() => {
    const keys = new Set<string>();
    for (const l of listings) {
      const id = ticketShowFor(l, links, shows);
      if (id && l.showDate >= today && !ticketMismatch(l, links, shows)) keys.add(`${l.showDate}|${id}`);
    }
    return [...keys].sort().slice(0, 12).map((k) => {
      const [date, showId] = k.split("|");
      return { show: shows.find((s) => s.id === showId)!, t: showTicketTotals(showId, date, listings, links, shows) };
    }).filter((n) => n.show);
  }, [listings, links, shows, today]);
  if (!nights.length) return null;
  return (
    <section className="rounded-xl bg-surface-low p-4 sm:p-6">
      <h2 className="mb-3 type-title-l">Coming up</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {nights.map(({ show, t }) => (
          <li key={`${t.date}${show.id}`} className="rounded-lg bg-surface-container p-4">
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate type-title-m">{show.name}</span>
                <span className="block type-body-s text-on-surface-variant">{spotDateLabel(t.date)} · {formatTime(show.startTime)}</span>
              </span>
              <span className="flex-none type-headline-s tabular-nums">
                {t.totalSold}
                <span className="type-title-s text-on-surface-variant">/{t.totalCapacity}</span>
              </span>
            </span>
            <ul className="mt-2 flex flex-col gap-1">
              {t.lines.map((x) => (
                <li key={x.key} className="flex items-center justify-between gap-2 type-body-s">
                  <span className="min-w-0 truncate">
                    {x.publicUrl ? <a href={x.publicUrl} target="_blank" rel="noreferrer" className="underline">{accounts.get(x.accountId)?.label ?? "Account"}</a> : accounts.get(x.accountId)?.label}
                    <span className="text-on-surface-variant"> · {TICKET_PLATFORM_NAMES[x.platform]}</span>
                  </span>
                  <span className="flex-none tabular-nums">{x.sold}/{x.capacity}</span>
                </li>
              ))}
            </ul>
            <div className="mt-2">
              <Synced at={t.oldestSyncedAt} now={now} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Tickets() {
  const { uid, shows, settings } = useApp();
  const now = useNow(30_000);
  const { accounts, listings, links, loading } = useTickets(uid);
  const [connect, setConnect] = useState<{ reconnect?: TicketAccount | null } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const today = localNow(new Date(now), settings.timezone).date;
  const accById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const groups = useMemo(() => {
    const by = new Map<string, TicketListing[]>();
    for (const l of listings) {
      if (!showEnded && (l.state === "ended" || l.showDate < today)) continue;
      const k = `${l.platform}:${l.accountId}:${l.listingId}`;
      by.set(k, [...(by.get(k) ?? []), l]);
    }
    const list = [...by.entries()].map(([k, rows]) => ({ k, rows: rows.sort((a, b) => (a.showDate + a.showTime).localeCompare(b.showDate + b.showTime)) }));
    // Not linked first: they need a decision.
    const isLinked = (k: string) => Number(linkedShowIds(links.get(k)).length > 0);
    return list.sort((a, b) => isLinked(a.k) - isLinked(b.k) || a.rows[0].showDate.localeCompare(b.rows[0].showDate));
  }, [listings, links, showEnded, today]);
  const unlinked = groups.filter((g) => !linkedShowIds(links.get(g.k)).length).length;

  const syncAll = async () => {
    setSyncing(true);
    try {
      const r = await syncNow(uid);
      toast.success(r.accounts ? `Synced ${r.accounts} account${r.accounts === 1 ? "" : "s"}, ${r.listings} show date${r.listings === 1 ? "" : "s"}.` : "No connected accounts to sync.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="w-full">
      <PageHeader
        title="Tickets"
        subtitle="Sales from your and your producers' BookMyShow accounts, per show night"
        actions={
          <>
            {accounts.length > 0 && (
              <Button variant="tonal" icon={IconRefresh} loading={syncing} onClick={() => void syncAll()}>
                Sync now
              </Button>
            )}
            <Button icon={IconAdd} onClick={() => setConnect({})}>
              Account
            </Button>
          </>
        }
      />
      <div className="flex flex-col gap-4 px-4 pb-24 sm:px-6">
        {loading ? (
          <div className="grid place-items-center py-16">
            <Spinner />
          </div>
        ) : accounts.length === 0 ? (
          <Empty icon={IconTicket} title="No ticket accounts yet" action={<Button icon={IconAdd} onClick={() => setConnect({})}>Connect BookMyShow</Button>}>
            Connect your HostMyShow organizer login, and any producer's whose shows you run. Then pick which show each listing belongs to, and every show night gets one ticket count across all of them.
          </Empty>
        ) : (
          <>
            <ComingUp listings={listings} links={links} shows={shows} today={today} now={now} accounts={accById} />
            <section className="rounded-xl bg-surface-low p-4 sm:p-6">
              <header className="mb-3 flex items-center gap-2">
                <h2 className="type-title-l">Accounts</h2>
                <Info label="About ticket accounts">
                  Your server signs in to each account and reads its listings every 15 minutes, every 5 in the 6 hours before a linked show. BookMyShow sessions last a day; the server renews them with the saved password. When BookMyShow asks for an OTP instead, the card asks you for it, and you get a notice.
                </Info>
              </header>
              <ul className="grid gap-3 sm:grid-cols-2">
                {accounts.map((a) => (
                  <AccountCard key={a.id} acc={a} now={now} listingCount={listings.filter((l) => l.accountId === a.id && l.state === "live").length} onReconnect={() => setConnect({ reconnect: a })} />
                ))}
              </ul>
            </section>
            <section className="rounded-xl bg-surface-low p-4 sm:p-6">
              <header className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 flex-1 type-title-l">Listings</h2>
                {unlinked > 0 && <Chip tone="error">{unlinked} not linked</Chip>}
                {unlinked === 0 && groups.length > 0 && <Chip tone="success" icon={IconCheck}>All linked</Chip>}
                <Button variant="text" size="sm" onClick={() => setShowEnded((v) => !v)}>
                  {showEnded ? "Hide past dates" : "Show past dates"}
                </Button>
              </header>
              {groups.length === 0 ? (
                <p className="type-body-m text-on-surface-variant">No upcoming show dates on the connected accounts.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {groups.map((g) => (
                    <ListingGroup key={g.k} rows={g.rows} account={accById.get(g.rows[0].accountId)} link={links.get(g.k)} shows={shows} now={now} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
      {connect && <ConnectSheet open onClose={() => setConnect(null)} reconnect={connect.reconnect} />}
    </div>
  );
}
