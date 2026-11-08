# Tickets

Ticket sales from organizer accounts (BookMyShow / HostMyShow DIY and District today; Swiggy Scenes next), tied to
the curator's shows. Types and rules: `packages/shared/src/tickets.ts`. Worker: `apps/worker/src/tickets/`. Page:
`apps/web/src/routes/Tickets.tsx`. The research proof of concept and capture tools are in `tools/ticket-sync/`.

## Data (under `users/{uid}`)

| Where | What | Written by |
| --- | --- | --- |
| `ticketAccounts/{id}` | label, masked login, status (`connected`, `needs_otp`, `needs_login`, `error`), last sync | worker |
| `ticketListings/{platform:listingId:sessionId}` | one show date: sold, capacity, bookings, `syncedAt` | worker |
| `ticketLinks/{platform:accountId:listingId}` | which show a listing counts toward, plus per-date exceptions | curator |
| `ticketPublic/key` | X25519 public key the browser seals logins to | worker |
| `ticketVault/{id}` | encrypted login, password and token; `_seal` holds the encrypted private key. No client access. | worker |
| `vaultKeys/{uid}_tickets` | AES key for `ticketVault` (separate from the WhatsApp vault key, so a WhatsApp logout keeps it) | worker |

## How a sync works

BookMyShow's API sits behind Cloudflare, which refuses plain HTTP clients and headless Chrome. The worker opens the same
Chrome that WhatsApp uses, headed but off-screen, loads a page on `diy.hostmyshow.com` and runs each API call as a
`fetch` from there. One ticket browser runs at a time per server, and it closes after each run.

- Cadence: every 15 minutes, and every 5 minutes in the 6 hours before a linked show. It runs only on the server
  holding the account's lease.
- Session: the access token lasts 24h and BookMyShow has no refresh grant. With under 3h left, the worker logs in again
  with the saved password. If BookMyShow asks for an OTP instead, the account becomes `needs_otp`, the curator gets a
  notice, and the card asks for the code.

## Linux servers

A server without a desktop needs a virtual display for the ticket browser: install `xvfb` and start the worker under
`xvfb-run -a`. Without it, ticket syncs fail with a clear message and nothing else is affected.

## District

Plain HTTPS from the worker (`apps/worker/src/tickets/district.ts`); no browser. `POST /mgw/events/v1/track` issues a
device `api_key` + `secret`; every call is signed the dashboard's way (`authorization: Hmac …` over `x-date`, HMAC-SHA1).
Connecting sends an SMS OTP (`sendOTP`, then `loginViaOTP` with `source: "publisher"`), which ties the key to the
organizer. Listings come from `event-search/search`, then each event's shows with per-ticket-type `finite_amount_sold`.
Shows hidden from the public page are kept when they have sales.
