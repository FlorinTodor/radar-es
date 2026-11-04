# Contributing to Radar España

*Léelo en español: [CONTRIBUTING.md](CONTRIBUTING.md).*

Thank you for wanting to improve [radarespaña.es](https://radarespaña.es). These are especially
welcome:

- **bug reports**: a train in an impossible place, a source that doesn't load, a notice that shouldn't
  be shown or is missing;
- **public data sources** that aren't included yet, under a reuse license;
- **improvements to the code, the texts and the accessibility** of the website.

First of all, read the section on the license: the code is not open source.

## The license and your contributions

The code belongs to its author, with **all rights reserved** (see [LICENSE](LICENSE)). It is published
so that it can be read, not to be reused in other projects.

- **What this guide allows you to do:** fork the repository and modify the code **only to propose
  changes to this project** through a pull request. It doesn't allow you to use, publish or
  distribute it for anything else.
- **What you agree to when you open a pull request:** that your contribution is your own work (or that
  you have the right to submit it), and that you grant the project's copyright holder, Florin Emanuel
  Todor Gliga, a free, perpetual, worldwide and irrevocable license to use, modify, publish and
  sublicense it as part of Radar España, under the same terms as the rest of the code. If you don't
  agree, open an issue with your idea instead of sending code.
- **Don't submit code copied** from other projects, or generated from code whose license doesn't
  allow it.

## Reporting a bug

Open an [issue](https://github.com/FlorinTodor/radar-es/issues) with:

- **what you saw and what you expected**;
- **where**: the train (number, line or operator), the station or the notice and, if you can, a
  screenshot;
- **when**: the date and time, because much of the data changes every few seconds;
- **your browser and device**, if it's a problem with the website.

**Security issues:** don't open a public issue. Write to
[radarespana@proton.me](mailto:radarespana@proton.me) and wait for a reply before disclosing it.

## Proposing a data source

Radar España only uses data that can legally be reused. A new source must meet all of these:

- **a reuse license checked in its original text**: CC BY, the license of Spain's National Access
  Point (NAP), the license of an open data portal…;
- **a public channel meant to be reused**: a GTFS, a GTFS-RT feed, an open API or an RSS feed. The
  internal endpoints of an app or a web viewer don't qualify, even if you can see them in the browser;
- **respect for its terms and its `robots.txt`**: if the source blocks requests or answers 403, it
  isn't worked around; access is requested instead;
- **the attribution it asks for**, on the map, in the details of what it shows and on `/legal`.

If you aren't sure about the license, open an issue with a link to the dataset and its terms before
writing any code. How to add a source to the code is explained in the README, in Spanish
([Añadir una fuente](README.md#añadir-una-fuente)).

## Sending changes

1. **Fork the repository** and create your branch from `dev`: `feature/<name>` for something new and
   `fix/<name>` for a fix.
2. **Make the change** following the architecture (see below), with its tests.
3. **Check that everything passes:** `npm test` must finish with no failures.
4. **Open the pull request against `dev`**, never against `produccion`.

Only the author merges into `dev` and deploys `dev` to production, after it has gone through the
test environment (see [Ramas](README.md#ramas) in the README).

### Architecture

The server follows a **hexagonal architecture** (see
[Arquitectura hexagonal](README.md#arquitectura-hexagonal) in the README):

- **The domain** (`server/domain/`) is pure: no network, no disk, no external dependencies.
- **The use cases** (`server/application/`) only talk to the outside world through the ports in
  `ports.js`.
- **Anything that reads or writes outside** is an adapter (`server/adapters/`), and `server/main.js`
  is the only place that wires them together.
- **Dependencies:** don't add a new one without discussing it in an issue first: the project keeps
  very few on purpose.

### Tests

- **Every change comes with its tests**, in `test/`, mirroring the structure of `server/`.
- **No network:** responses from the sources are simulated.
- **No dependence on real time or on the speed of the machine:** no "wait 50 ms and check". Use
  simulated clocks (`now: () => t`, `t.mock.timers`) or wait for an explicit signal. The tests also
  run on the server, which is much slower than a regular computer.
- **If your change loads more data or does more work**, say so in the pull request: the server has
  just enough memory.

### Commits

- **In Spanish if you can**, since the whole history is in Spanish; otherwise in clear English. One
  logical change per commit.
- **The message says what changes and why**, thinking of the people who use the map. Put the part it
  affects first if that helps: "Official notices: a new one for the whole region replaces the earlier
  ones for each province".
- **No generic messages** such as "fix", "changes" or "misc fixes".

### The pull request

- **What it does and why**, and the issue it solves, if there is one.
- **How you tested it**: `npm test` and, if the website changes, a screenshot.
- **If it adds a source**: its license, its attribution and a link to its terms.
- **Small and focused on one thing:** unrelated changes are better in separate pull requests.

The author reviews every pull request. It may take a few days and, if something doesn't fit the
project, the author will explain why.

## Website texts

- **In Spanish** (and in English on the English page), clear and without jargon for people who
  aren't railway experts.
- **Estimates are labelled:** a position calculated from the timetable is marked as estimated and is
  never presented as GPS.
- **Each source's data is cited with its attribution** and, if it is modified, the text says what has
  been done to it.

## What's left to do

Pending ideas are listed in the README (in Spanish):
- [Posibles mejoras](README.md#posibles-mejoras) (possible improvements);
- [Pendiente y conocido](README.md#pendiente-y-conocido) (known gaps), including data nobody
  publishes yet.

If you want to take one on, open an issue first so you can discuss it and avoid duplicated work.
