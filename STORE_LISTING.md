# Chrome Web Store listing: Train of Thought v0.2.2

## Product details

**Category:** Productivity

**Language:** English

**Summary:** One locomotive, many tracks. Switch context without losing your train of thought.

**Detailed description:**

Train of Thought is a calm Chrome side panel for switching between trains of thought without losing your place.

Lay a track for each project or thread. Keep one locomotive, your attention, on exactly one track at a time. Switch freely, or leave an optional Stop describing where to pick the work back up. When you return, that cue is waiting for you.

Train of Thought includes:

- A calm, scrollable yard for three to ten active tracks with persistent manual ordering
- Optional Stop markers for meaningful return points, while every switch is preserved in Track history
- Notes you can add to inactive tracks without changing your current track
- Expandable Track Details with switches, Stops, Notes, ride durations, status changes, and arrival
- Arrivals history with start time, arrival time, total active time, and full Track history
- Inline track rename, drag to reorder, and recoverable Delete for unwanted tracks
- Manual ready signals for work that is waiting on someone or something else
- Daytime and nighttime themes, reduced-motion support, and keyboard shortcuts
- Local export and erase controls

Privacy is structural: there is no account, server, advertising, or remote code. All data stays in Chrome storage on your device. Optional hostname observation is off by default and starts only if you enable it in Settings. Train of Thought has no host permissions and cannot read page contents.

## Privacy practices

**Single purpose:** Help users switch between concurrent trains of thought and return to the exact place they left off.

**sidePanel justification:** Displays Train of Thought's primary interface in Chrome's side panel so it can stay accessible alongside the user's work.

**storage justification:** Stores tracks, settings, optional local hostname associations, and a local usage log on the user's device.

**tabs justification:** Reads active-tab URLs only after the user explicitly enables optional context learning, immediately reducing them to hostnames stored locally. It does not store full URLs or page contents.

**alarms justification:** Periodically flushes opted-in hostname association counts from memory to local Chrome storage without continuous background execution.

**Remote code:** No, Train of Thought does not use remote code.

**Data disclosures:** Disclose **Web browsing activity** and **User-generated content**. Both are processed and stored only on the user's device and are not transmitted to the developer or third parties.

Certify all Limited Use statements. Train of Thought uses data only for its disclosed single purpose; does not sell or transfer it; does not use it for advertising, lending, or creditworthiness; and does not permit human access.

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

1. Click the toolbar icon to open the Train of Thought side panel.
2. Enter a track name and choose **lay track**.
3. Choose **switch tracks**, optionally leave a pickup note, and create or select another track.
4. Hover an inactive track to add a Note, or click a Stop or Note marker to open Track Details.
5. Select the original track to resume it, or mark a track Arrived to move it into Arrivals.
6. Open Settings to review local-only data controls and the optional, off-by-default hostname observation setting.
