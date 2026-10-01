# Noon

The spec is `SPEC.md`. `./init.sh` boots the dev environment and proves it works.

## Public demo

The app is shown from this laptop through an ngrok static domain (E11): the compose api with the public
addresses, Vite for the public host on 5173, Vite for localhost on 5199, and ngrok in front of 5173.

```sh
scripts/demo.sh up       # starts what is not running, detached; a piece already on its port is left alone
scripts/demo.sh status   # each piece, and whether the public URL answers /api/ready through basic auth
scripts/demo.sh down     # stops what `up` started; the compose stack stays
```

`up` assumes `./init.sh` has brought up the compose stack. Pid files and logs are in `~/.local/state/noon-demo`.

One-time files under `~/.config/noon` (personal, never in the repo):

- `ngrok-host`: the ngrok static domain
- `ngrok-pass`: the basic-auth password of user `noon`
- `ngrok-policy.yml`: the ngrok traffic policy, basic auth (the same credentials) on everything except `/preview/`
