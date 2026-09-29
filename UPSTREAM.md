# Upstream maintenance

This repository was extracted with `git subtree split` from [`tifandotme/pi-extensions`](https://github.com/tifandotme/pi-extensions).

- Upstream baseline: `d753b5c6e7a32534c8ff84cb1059d98cb2731f28`
- Upstream prefix: `packages/pi-inline-skills`
- Initial filtered commit: `689b311ff6cb093acdf7c6d3dac5ffa720e0904a`

To prepare a later upstream update without rewriting either repository's history:

```fish
set upstream_checkout /path/to/pi-extensions

git -C $upstream_checkout fetch origin
git -C $upstream_checkout checkout --detach origin/master
set split_commit (git -C $upstream_checkout subtree split --prefix=packages/pi-inline-skills HEAD)

git fetch $upstream_checkout $split_commit
git merge --ff-only FETCH_HEAD
```

If the fork has diverged and the final merge is not a fast-forward, inspect the filtered commits and use a normal merge or selected cherry-picks. Do not force-push or regenerate the existing filtered history.
