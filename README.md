# Trust Wallet TRON dApp + Safe Admin Dashboard

This project now has two parts:

- Mobile dApp (Trust Wallet + TRON transactions)
- Desktop admin dashboard (request orchestration only, no silent signing)

## Security Model

Admin **cannot** directly move user funds.
Admin can only create transaction requests. User must approve/sign in Trust Wallet for every blockchain action.

## Features

### Mobile dApp

- Trust Wallet focused connect flow on mobile
- TRON Mainnet session
- Manual actions:
  - TRX send
  - TRC20 approve
  - TRC20 transfer
- Receives admin transaction requests
- User can approve or reject each request

### Admin Dashboard (PC/Laptop)

- View connected wallet sessions
- Create transaction requests:
  - `send_trx`
  - `trc20_transfer`
  - `trc20_approve`
- Live status updates via WebSocket
- Request/event audit logs

## Tech Stack

- Frontend: Vite + vanilla JS
- Backend: Express + WebSocket (`ws`)
- Chain: `tronweb` + `@tronweb3/walletconnect-tron`

## Environment Setup

```bash
copy .env.example .env
```

Edit `.env`:

```env
VITE_WALLETCONNECT_PROJECT_ID=your_walletconnect_project_id
VITE_TRONGRID_API_KEY=
VITE_BACKEND_HTTP_URL=http://192.168.1.10:8787
VITE_BACKEND_WS_URL=ws://192.168.1.10:8787/ws
ADMIN_SERVER_PORT=8787
ADMIN_SECRET=change-this-admin-secret
```

Notes:

- Use your real LAN IP in `VITE_BACKEND_HTTP_URL` / `VITE_BACKEND_WS_URL` so phone can reach backend.
- `VITE_TRONGRID_API_KEY` is optional but recommended for production.
- Change `ADMIN_SECRET` before real usage.

## Install

```bash
npm install
```

## Run (Development)

Run in two terminals:

### Terminal 1 (backend/admin)

```bash
npm run dev:server
```

Admin page:

`http://localhost:8787/admin`

### Terminal 2 (mobile dApp)

```bash
npm run dev:client
```

Open Vite LAN URL in Trust Wallet mobile dApp browser.

## Build Frontend

```bash
npm run build
npm run preview
```

## Key Files

- `index.html` - mobile dApp UI
- `src/main.js` - wallet connect, tx logic, admin request approval flow
- `src/style.css` - mobile dApp styles
- `server/server.js` - API + WebSocket + persistence + admin auth
- `server/public-admin/index.html` - admin dashboard page
- `server/public-admin/admin.js` - admin dashboard logic
- `server/public-admin/admin.css` - admin dashboard styles
- `server/data/store.json` - runtime data store (auto-created)

## API Summary

Public wallet routes:

- `POST /api/wallet/register`
- `POST /api/wallet/heartbeat`
- `POST /api/wallet/disconnect`
- `GET /api/wallet/:clientId/pending-requests`
- `POST /api/request/:requestId/result`

Admin routes (require `x-admin-secret`):

- `GET /api/admin/snapshot`
- `POST /api/admin/requests`
- `GET /api/admin/wallets`
- `GET /api/admin/requests`
- `GET /api/admin/events`
