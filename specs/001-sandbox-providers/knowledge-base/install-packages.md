# How to install system packages in Vercel Sandbox
Last updated January 29, 2026
By Amy Burns

---

The sandbox comes with a base set of tools pre-installed, including Node.js, Python, Git, and common utilities. You can see the full list in the [System Specifications](https://vercel.com/docs/vercel-sandbox/system-specifications) docs. When your use case requires something beyond the defaults, you can install it yourself using `dnf` on the `RunCommand` method.

The sandbox runs Amazon Linux 2023, so you’ll install packages using `dnf`, the system's package manager. Any command that modifies system packages needs root privileges, which you can enable by setting `sudo: true`.   

## [Install packages with TypeScript](#install-packages-with-typescript)

In this example, we’ll install Go using TypeScript and the [Sandbox](https://vercel.com/docs/vercel-sandbox/sdk-reference?__vercel_draft=1#sandbox.runcommand) `runCommand`:

```
import { Sandbox } from '@vercel/sandbox';
const sandbox = await Sandbox.create();
await sandbox.runCommand({  cmd: 'dnf',  args: ['install', '-y', 'golang'],  sudo: true,});
```

You’ll pass any arguments and flags that you normally would. For example, the `-y` flag automatically confirms the installation prompt.                                                                                                    

## [Install packages with Python](#install-packages-with-python)

And in Python:

```
from vercel.sandbox import Sandbox
sandbox = Sandbox.create()
sandbox.run_command(  'dnf',  ['install', '-y', 'golang'],  sudo=True,)
```

Set `sudo: true` because package installation requires root privileges.

## [Persistence](#persistence- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -)                                                                                                        

Packages you install don't persist between sessions. When a sandbox shuts down, any packages you added are lost. If you're setting up an environment you want to reuse, install your packages and then [create a snapshot](https://vercel.comhttps://vercel-docs-git-timeyoutakeit-sandbox-sdk-and-update.vercel.sh/docs/vercel-sandbox/concepts/snapshots#create-a-snapshot) of the sandbox. When you create a new sandbox from that snapshot, your packages will already be there.    

## [Available packages](#available-packages)

The sandbox runs Amazon Linux 2023. Check the [Amazon Linux 2023 package list](https://docs.aws.amazon.com/linux/al2023/release-notes/all-packages-AL2023.7.html) to see what's available.

Common examples include:

*   Language runtimes: `golang, rust, ruby`
*   Build tools: `make, cmake, gcc`
*   Utilities: `jq, htop, tmux`