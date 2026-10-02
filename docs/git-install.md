# Git repository and installation

Pi packages can be installed from npm, git, a URL, or a local directory. This repository is structured so the same tree can be used directly as a git-installed Pi package.

## Create a repository from the release folder

From the package root:

```sh
git init
git add .
git commit -m "Initial pi-semantic-screen release"
git branch -M main
git remote add origin <your-repository-url>
git push -u origin main
```

Create a version tag:

```sh
git tag v0.2.1
git push origin v0.2.1
```

The repository intentionally does not contain generated `.zip`/`.tgz` release files, `node_modules`, credentials, or local review evidence.


## Create and publish with GitHub CLI (`gh`)

From PowerShell in the package root:

```powershell
gh auth login

git init
git add .
git commit -m "Initial release v0.2.1"
git branch -M main

gh repo create pi-semantic-screen --public --source=. --remote=origin --push --description "Adapter-driven semantic screening and resumable evidence review for Pi Code Mode"

git tag -a v0.2.1 -m "pi-semantic-screen v0.2.1"
git push origin v0.2.1

gh release create v0.2.1 --title "pi-semantic-screen v0.2.1" --generate-notes --verify-tag
```

`gh repo create --source=. --push` publishes the existing local repository and configures the `origin` remote. The repository already contains the MIT `LICENSE`, so do not ask GitHub CLI to generate a second license file. GitHub CLI can also create the release directly from the pushed tag.

To install the tagged release for the currently authenticated GitHub user:

```powershell
$owner = gh api user --jq .login
pi install "git:github.com/$owner/pi-semantic-screen@v0.2.1"
```

## Install in Pi from GitHub

Unpinned development branch:

```text
pi install git:github.com/<owner>/pi-semantic-screen
```

Pinned release tag:

```text
pi install git:github.com/<owner>/pi-semantic-screen@v0.2.1
```

Project-local package declaration:

```text
pi install -l git:github.com/<owner>/pi-semantic-screen@v0.2.1
```

A normal HTTPS repository URL is also treated by Pi as a git package source.

Pinned tags/commits do not move when the repository's default branch advances. Install a new tag/ref explicitly when upgrading a pinned installation.

## Local development install

```text
pi install ./pi-semantic-screen
```

One invocation without saving package configuration:

```text
pi -e ./pi-semantic-screen
```

After editing a local package, restart/reload Pi as appropriate and run the repository checks before committing.

## Runtime dependencies for git installs

Pi installs package runtime dependencies for managed git packages. The Pi host packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) are declared as peer dependencies because Pi supplies them.

The built-in `python-exceptions` adapter additionally requires a local Python 3.9+ interpreter, but no third-party Python modules.

## Public repository checklist

Before making the repository public:

- verify the MIT license notice in `LICENSE`;
- replace the placeholder private-reporting text in `SECURITY.md` with a real contact method;
- optionally add `repository`, `homepage`, and `bugs` fields to `package.json` after the final repository URL exists;
- enable GitHub Actions if desired;
- create a tagged release rather than committing generated archives to the repository.
