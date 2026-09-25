# Houston trademark policy

Houston's **code** is open source under the [Apache License 2.0](LICENSE). Houston's
**name and logo** are not. This page explains where the line falls, so you can fork,
package, and write about Houston without having to ask.

Nothing here restricts your rights under the Apache License. It grants you
*additional* permission to use the marks in the ways described below.

## What this covers

- The name **Houston**, as a name for this software.
- The Houston icon and logo artwork, including `build/icon.png`, `build/icon.icns`,
  `build/icon.ico`, `website/public/assets/icon.png`, `website/public/assets/og.svg`,
  `website/public/favicon.ico`, and the apple-touch icons, along with any file derived from
  them.
- The domain **houstoncode.ai** and the project's accounts and handles.

Collectively, "the Houston marks."

## Two different rights

Section 6 of the Apache License is explicit that it grants no trademark rights, so
the name is reserved automatically. The logo is a second, separate thing: artwork is
protected by copyright as well as trademark, so the Apache grant over this
repository is **carved out** for the icon and logo files listed above. They are
included in the repository so the project can build and ship itself, not as material
you are licensed to copy and modify.

Everything else in the repository, source and non-source alike, is Apache-2.0 with
no carve-out.

## You do not need to ask

These uses are fine, and this policy is your permission:

- **Redistributing Houston unmodified.** Ship the official binaries or an unmodified
  build under the name Houston, including in a package manager (Homebrew, AUR,
  Nixpkgs, Winget, Flatpak, and the like), with the icon intact. Keep the `NOTICE`
  file, as the license already requires.
- **Distribution patches.** Packagers routinely need small changes: build flags,
  paths, unbundled dependencies, backported fixes. Keeping the name is fine as long
  as the result still behaves like Houston and you say where to report bugs.
- **Referring to Houston.** Say your tool works with Houston, is built on Houston,
  is a plugin or MCP server for Houston, or is a fork of Houston. Use the name in
  articles, talks, tutorials, comparisons, reviews, course material, and academic
  work. Use it as much as accuracy needs, and no more.
- **Showing the logo when you mean Houston.** Screenshots, slides, a link icon in a
  list of tools, an entry in a package registry. Use the artwork as published,
  without recoloring, distorting, or building it into your own logo.
- **Your own fork, described honestly.** "Based on Houston" or "a fork of Houston"
  in your description is a factual statement about origin, and always allowed. See
  the next section for what your fork should be *called*.

## Please rename first

These uses need a different name, or our written permission:

- **Distributing a modified build under the name Houston.** If you change what the
  software does and hand it to other people, call it something else. This is the
  main thing this policy asks of you: a user who installs "Houston" should get
  Houston. Distribution patches, above, are the narrow exception.
- **Naming your own project after ours.** Not Houston, and not a name close enough
  to be confused with it. Names of the form "Houston for X" or "X Houston" read as
  official releases, so avoid those too. "X for Houston" is fine, since it describes
  what your thing does rather than claiming to be ours.
- **Domains, accounts, and handles** containing Houston in a way that suggests you
  are the project, or that you speak for it.
- **Implying endorsement, affiliation, or certification.** No "official", "certified",
  "partner", or "powered by Houston" where a reader would take it as our approval.
- **Modifying the logo,** using it as the basis of your own mark, or using it as your
  app icon, favicon, or avatar for something that is not Houston.
- **Merchandise** carrying the name or logo.

## Asking

If your use is not clearly covered, ask at **dev@houstoncode.ai** and describe what
you want to do. We would rather say yes to a described use than have you guess.

Permission granted in one place is not a general licence: it covers what you
described, for as long as this policy stands behind it.

## Changes

We may update this policy. The version in the repository at the time you rely on it
is the one that applies to what you have already published, and we will not use a
later revision to make an existing, good-faith use retroactively improper.

This policy is about avoiding confusion for the people who use Houston. It is not a
tool for policing criticism: unflattering reviews, comparisons, and forks that
disagree with our choices are exactly the uses the "you do not need to ask" section
is there to protect.
