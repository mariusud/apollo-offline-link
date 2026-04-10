# Expo Demo

This demo app shows offline mutation queueing with the offline link.

## Install

```bash
cd /Users/mariusudnaes/Development/apollo-offline-link
npm install
npm run build

cd /Users/mariusudnaes/Development/apollo-offline-link/examples
npm install
```

## Run

```bash
npm run start
```

Then press **Send Mutation**. Disable network to see it queue, then re-enable to replay.

Notes:
- This demo uses a local workspace dependency; `metro.config.js` enables resolving the package from the repo root.
