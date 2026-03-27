# Publishing this repo to GitHub

## Option 1: Create and push with GitHub CLI

Prerequisite: install and authenticate GitHub CLI (`gh auth login`).

From this repo root:

```bash
bash scripts/create-and-push-with-gh.sh your-github-username conversation-intelligence-docs public
```

Arguments:
- arg 1: GitHub owner/user or org
- arg 2: repo name
- arg 3: visibility (`public` or `private`)

## Option 2: Push to an empty GitHub repo you already created

Create an empty repository on GitHub first, then run:

```bash
bash scripts/publish-existing-to-github.sh https://github.com/YOUR-USER/YOUR-REPO.git
```

## Notes

- These scripts push the current `main` branch.
- They remove any existing `origin` remote before setting the new one.
- Use a **new empty repo** on GitHub to avoid conflicts.
