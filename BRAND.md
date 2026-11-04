# Brand — CADRE

Two layers: the **mark** (a bespoke geometric numeral, drawn as paths, with the dial inside the zero) and the **emblem** (the heavy mark in bevelled gold inside a laurel wreath, with a moving sheen). The emblem is the hero piece — splash, season card, kit, X header, avatar, card seals; the mark does the everyday work — header, favicon, badge, card headers.

Emblem: `emblemSvg({ size, animate, flat, wreath, the, glow })` in the emblem module. Gold = linear gradient `#F8EBBE → #DCC078 → #FFF3C9 → #C9A95E → #8C7232`, lit by an SVG specular filter (`fePointLight`) with a drop shadow; `flat:true` for contexts without filter support. The wreath is two mirrored laurel branches of 13 pointed leaves each. On the site the light follows the cursor and the badge tilts; on first visit per session the emblem draws itself on black before the page opens (skippable, respects reduced motion).

Numeral weight: heavy (stroke 15 on a 60 cap height, box 122 × 60; stacked lockup 122 × 82).

- **"2"**: monoline, arc + diagonal + base, sharp mitre at the foot.
- **"0"**: elliptical ring. Inside it, **twenty hairline notches** (the seats, seat 01 at the top, clockwise) and **two lozenge indices** at **14:00** and **20:00 UTC** (a purely graphic mark; launch times are free).
- **"THE"**: small, letter-spaced monoline caps above the numeral (stacked lockup only).
- **Now dot** (UI only): a dot that walks the inside of the zero with UTC time. Never in static assets.
- Units: the "20" sits in a 100 × 60 box, the stacked lockup in 100 × 82. Stroke 8.

Lockups
- **Stacked** (THE over 20): the primary mark. Header, kit, documents. Minimum 24 px tall.
- **Mono** ("20"): cards, footer, watermarks, anywhere the name is already written next to it.
- **Coin** ("20" on a violet disc): avatars, favicons, badges. Below 48 px the dial is dropped.

Colour: violet `#D2B46C` on graphite; violet dark `#876C2B` on bone; the metal gradient `#F1E0A6 → #D2B46C → #9A8449` for coins and large marks only. Never recolour the numeral; on light surfaces the violet darkens.

Clear space: the height of the "THE" on every side. Never rotate, outline, or set the numeral in a typeface — the mark is the drawing.

Files: `web/brand/cadre-*.svg` (stacked dark/violet/white, mark gradient/violet, coin, emblem). Source of truth: `MARK`, `markSvg()` and `drawMarkCanvas()` in `web/index.html` (mark module). The media kit on the site (`#brand`) exports SVG and PNGs.

Wordmark: CADRE, Big Shoulders Display 600, uppercase, letter-spacing .16em — secondary, next to or below the mark.
Type: Cormorant Garamond 600 (headlines, sentence case; italic for the accent word), Big Shoulders Display (display numerals: seat numbers, countdowns, scores), IBM Plex Sans (text), IBM Plex Mono (numbers in tables, labels, kickers).
Colours: graphite `#0F1113` · panel `#161B1F` · bone `#ECE7DB` · violet `#D2B46C` · violet dark `#876C2B` · good `#58C78A` · warn `#E89A45` · bad `#E25A5F`.
