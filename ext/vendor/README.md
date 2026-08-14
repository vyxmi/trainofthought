# vendor/

Drop `gsap.min.js` and `MotionPathPlugin.min.js` here, then set `USE_GSAP = true`
in `../lib/anim.js` and add the two script tags to `../sidepanel/index.html`.
See the "Swapping in GSAP" section of the top-level README.

MV3 forbids loading scripts from a CDN, so they must live in the extension.
Until then `lib/anim.js` uses its own path-follower and nothing here is needed.
