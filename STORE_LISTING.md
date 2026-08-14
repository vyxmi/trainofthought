# Chrome Web Store listing: Trainyard v0.1.0

## Product details

**Category:** Productivity

**Language:** English

**Summary:** One locomotive, many tracks. Switch context without losing your train of thought.

**Detailed description:**

Trainyard is a calm Chrome side panel for switching between trains of thought without losing your place.

Lay a track for each project or thread. Keep one locomotive, your attention, on exactly one track at a time. Before switching, leave a short stop describing where to pick the work back up. When you return, that cue and an optional restorable tab snapshot are waiting for you.

Trainyard includes:

- A side-panel yard that keeps active, parked, waiting, AI-working, ready, and arrived work legible at a glance
- A deliberate switch flow that preserves your return point
- Optional tab snapshots captured only when you leave a track
- Manual ready signals for work that is waiting on someone or something else
- Light and dark themes, reduced-motion support, and keyboard shortcuts
- Local export and erase controls

Privacy is structural: there is no account, server, advertising, or remote code. All data stays in Chrome storage on your device. Optional hostname observation is off by default and starts only if you enable it in Settings. Trainyard has no host permissions and cannot read page contents.

## Privacy practices

**Single purpose:** Help users switch between concurrent trains of thought and return to the exact place they left off.

**sidePanel justification:** Displays Trainyard's primary interface in Chrome's side panel so it can stay accessible alongside the user's work.

**storage justification:** Stores tracks, settings, optional tab snapshots, optional local hostname associations, and a local usage log on the user's device.

**tabs justification:** Reads tab titles and URLs only to capture a restorable snapshot when the user deliberately leaves a track, and reads active-tab hostnames only after the user explicitly enables optional context learning. It also restores saved tabs only when the user requests it.

**alarms justification:** Periodically flushes opted-in hostname association counts from memory to local Chrome storage without continuous background execution.

**Remote code:** No, Trainyard does not use remote code.

**Data disclosures:** Disclose **Web browsing activity** and **User-generated content**. Both are processed and stored only on the user's device and are not transmitted to the developer or third parties.

Certify all Limited Use statements. Trainyard uses data only for its disclosed single purpose; does not sell or transfer it; does not use it for advertising, lending, or creditworthiness; and does not permit human access.

**Privacy policy URL:** https://github.com/vyxmi/trainofthought/blob/main/PRIVACY.md

**Homepage URL:** https://github.com/vyxmi/trainofthought

**Support URL:** https://github.com/vyxmi/trainofthought/issues

## Distribution

- Visibility: Public
- Regions: All regions
- Pricing: Free
- Mature content: No

## Test instructions

No account or credentials are required.

1. Click the toolbar icon to open the Trainyard side panel.
2. Enter a track name and choose **lay track**.
3. Choose **switch tracks**, leave a current stop, and create or select another track.
4. Select the original track to resume it.
5. Open Settings to review local-only data controls and the optional, off-by-default hostname observation setting.
