"use client";
import { FOCUS_SECTION_LABELS, type FocusSection } from "@aegis/domain";
import { Columns2, Crosshair, Inbox, LayoutList, Monitor, Moon, Pin, PinOff, Rows3, Square, Sun, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChoiceGroup, Head, PageSkeleton, usePrefPatch } from "@/components/settings/common";
import { Banner, Button, Card, ErrorState, Field, inputClass, Toggle } from "@/components/ui";
import { applyTheme } from "@/components/workspace/shell";
import { useMe, usePrefs, useToast } from "@/lib/client";

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: new Date(2026, 0, 1, h).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) }));

function HourSelect({ label, value, onChange, end }: { label: string; value: number; onChange: (n: number) => void; end?: boolean }) {
  return <Field label={label}><select className={inputClass} value={value} onChange={e => onChange(Number(e.target.value))}>{HOURS.map(h => <option key={h.value} value={h.value}>{h.label}</option>)}{end && <option value={24}>End of day</option>}</select></Field>;
}

function zones(current: string) {
  let list: string[] = [];
  try { list = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone"); } catch { /* older browsers */ }
  return list.includes(current) ? list : [current, ...list];
}

function Hours({ prefs }: { prefs: any }) {
  const patch = usePrefPatch("Saved.");
  const browserTz = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; } }, []);
  const [workOn, setWorkOn] = useState<boolean>(!!prefs.workingHours);
  const [start, setStart] = useState<number>(prefs.workingHours?.start ?? 9);
  const [end, setEnd] = useState<number>(prefs.workingHours?.end ?? 17);
  const [tz, setTz] = useState<string>(prefs.timeZone ?? prefs.workingHours?.tz ?? browserTz);
  const [quietOn, setQuietOn] = useState<boolean>(!!prefs.quietHours);
  const [quietStart, setQuietStart] = useState<number>(prefs.quietHours?.start ?? 22);
  const [quietEnd, setQuietEnd] = useState<number>(prefs.quietHours?.end ?? 7);
  const allZones = useMemo(() => zones(tz), [tz]);
  return (
    <Card title="Working hours and quiet hours">
      <p className="mb-3 text-[13px] text-muted">Notifications that aren&apos;t urgent wait until your working hours and the end of any quiet hours, in this time zone. They&apos;re never lost: anything held back is shown as soon as these hours allow, within two days at the latest.</p>
      <div className="space-y-4">
        <div className="max-w-sm"><Field label="Time zone"><select className={inputClass} value={tz} onChange={e => setTz(e.target.value)}>{allZones.map(z => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}</select></Field></div>
        <fieldset className="space-y-3 border-t border-line pt-3">
          <legend className="sr-only">Working hours</legend>
          <Toggle label="Working hours" checked={workOn} onChange={setWorkOn} description="Outside these hours, notifications that aren't urgent wait. Security alerts don't." />
          {workOn && <div className="grid gap-3 sm:grid-cols-2">
            <HourSelect label="Start" value={start} onChange={setStart} />
            <HourSelect label="End" value={end} onChange={setEnd} end />
          </div>}
        </fieldset>
        <fieldset className="space-y-3 border-t border-line pt-3">
          <legend className="sr-only">Quiet hours</legend>
          <Toggle label="Quiet hours" checked={quietOn} onChange={setQuietOn} description="During these hours, nothing is shown, including security alerts unless you allow them below." />
          {quietOn && <div className="grid gap-3 sm:grid-cols-2"><HourSelect label="From" value={quietStart} onChange={setQuietStart} /><HourSelect label="Until" value={quietEnd} onChange={setQuietEnd} /></div>}
        </fieldset>
        {workOn && end <= start && <Banner tone="warn">Working hours end before they start. Check these times.</Banner>}
        <Button disabled={workOn && end <= start} loading={patch.isPending} onClick={() => patch.mutate({ timeZone: tz, workingHours: workOn ? { start, end, tz } : null, quietHours: quietOn ? { start: quietStart, end: quietEnd } : null })}>Save hours</Button>
      </div>
    </Card>
  );
}

function Alerts({ prefs }: { prefs: any }) {
  const patch = usePrefPatch("Saved.");
  const { data: me } = useMe();
  const toast = useToast();
  const supported = typeof window !== "undefined" && "Notification" in window;
  const setBrowser = async (on: boolean) => {
    if (on) {
      const r = await Notification.requestPermission();
      if (r !== "granted") { toast({ text: "Your browser didn't allow notifications, so this stays off.", tone: "danger" }); return; }
    }
    patch.mutate({ browserNotifications: on });
  };
  return (
    <Card title="Notifications" description="The bell at the top of the app always shows them. These are optional extras.">
      <div className="divide-y divide-line">
        <Toggle label="Security alerts during quiet hours" checked={prefs.criticalBypassQuiet === true} onChange={criticalBypassQuiet => patch.mutate({ criticalBypassQuiet })} description="Show alerts about messages rated malicious right away, even in quiet hours. Off means they wait with everything else." />
        <Toggle label="Daily email digest" checked={prefs.emailDigest === true} disabled={me?.mailAvailable === false || me?.emailVerified === false} onChange={emailDigest => patch.mutate({ emailDigest })} description={me?.mailAvailable === false ? "This deployment can't send email yet." : me?.emailVerified === false ? "Confirm your email address first." : "Counts of what's waiting, once a day in your working hours. It never includes subjects, senders or message content."} />
        <Toggle label="Browser notifications" checked={prefs.browserNotifications === true} disabled={!supported} onChange={setBrowser} description={supported ? "While the app is open, also show a notification from your browser, with a general title and no message content." : "This browser doesn't support them."} />
      </div>
    </Card>
  );
}

function Sections({ prefs }: { prefs: any }) {
  const patch = usePrefPatch();
  const hidden: string[] = prefs.hiddenSections ?? [], pinned: string[] = prefs.pinnedSections ?? [];
  const keys = Object.keys(FOCUS_SECTION_LABELS) as FocusSection[];
  return (
    <Card title="Focus sections" description="Hide what you don't want and pin what you want first. Hidden sections only leave Focus: the mail stays in your inbox.">
      <ul className="divide-y divide-line">
        <li className="flex flex-wrap items-start justify-between gap-x-4" data-testid="section-row" data-section="digest"><div className="min-w-0 flex-1 basis-56"><Toggle label="Digest" checked={!hidden.includes("digest")} onChange={show => patch.mutate({ hiddenSections: show ? hidden.filter(x => x !== "digest") : [...hidden, "digest"] })} description="A short count of what's new, for a period you choose on the Focus screen." /></div>{/* Same column as the Pin buttons below, so every switch lines up. Digest always sits at the top. */}<div className="invisible py-2" aria-hidden><Button size="sm" variant="ghost" icon={Pin} tabIndex={-1}>Pin</Button></div></li>
        {keys.map(k => {
          const label = FOCUS_SECTION_LABELS[k], isPinned = pinned.includes(k), isHidden = hidden.includes(k), safety = k === "security_review";
          return (
            <li key={k} className="flex flex-wrap items-start justify-between gap-x-4" data-testid="section-row" data-section={k}>
              <div className="min-w-0 flex-1 basis-56">
                {safety ? <div className="flex items-start justify-between gap-3 py-2.5"><div><div className="text-sm font-medium">{label}</div><p className="mt-0.5 text-[13px] text-muted">Always shown, so a flagged message can't drop out of sight.</p></div><span className="shrink-0 pt-0.5 text-[13px] font-medium text-muted">Always on</span></div>
                  : <Toggle label={label} checked={!isHidden} onChange={show => patch.mutate({ hiddenSections: show ? hidden.filter(x => x !== k) : [...hidden, k] })} />}
              </div>
              <div className="py-2"><Button size="sm" variant="ghost" icon={isPinned ? PinOff : Pin} disabled={isHidden} aria-pressed={isPinned} onClick={() => patch.mutate({ pinnedSections: isPinned ? pinned.filter(x => x !== k) : [...pinned, k] })} aria-label={`${isPinned ? "Unpin" : "Pin"} ${label}`}>{isPinned ? "Pinned" : "Pin"}</Button></div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export default function PersonalizationPage() {
  const { data: prefs, isLoading, error, refetch } = usePrefs();
  const patch = usePrefPatch();
  const [theme, setTheme] = useState<string | undefined>();
  useEffect(() => { setTheme(prefs?.theme ?? "system"); }, [prefs?.theme]);
  return (
    <>
      <Head title="Appearance and AI" description="Changes save as you make them." />
      {isLoading ? <PageSkeleton blocks={4} /> : error || !prefs ? <ErrorState error={error ?? { message: "Preferences aren't available." }} retry={() => refetch()} /> : (
        <div className="space-y-4">
          <Card>
            <ChoiceGroup legend="Open to" hint="What you see when you open the app. Switch any time." value={prefs.defaultView ?? "inbox"} onChange={defaultView => patch.mutate({ defaultView })} options={[
              { value: "focus", label: "Focus", icon: Crosshair, description: "Ranked by what needs you, with the reason shown." },
              { value: "inbox", label: "Inbox", icon: Inbox, description: "Every message, newest first, like classic email." },
            ]} />
          </Card>
          <Card>
            <div className="space-y-4">
              <ChoiceGroup legend="Theme" columns={3} value={theme as "system" | "light" | "dark" | undefined} onChange={v => { setTheme(v); applyTheme(v); patch.mutate({ theme: v }); }} options={[
                { value: "system", label: "Match my device", icon: Monitor }, { value: "light", label: "Light", icon: Sun }, { value: "dark", label: "Dark", icon: Moon },
              ]} />
              <ChoiceGroup legend="Density" columns={3} value={prefs.density ?? "comfortable"} onChange={density => patch.mutate({ density })} options={[
                { value: "compact", label: "Compact", description: "More messages on screen." }, { value: "comfortable", label: "Comfortable", description: "A balance of both." }, { value: "spacious", label: "Spacious", description: "More room around each message." },
              ]} />
              <ChoiceGroup legend="Mail layout" value={prefs.layout ?? "split"} onChange={layout => patch.mutate({ layout })} options={[
                { value: "split", label: "Split", icon: Columns2, description: "List beside the open message." },
                { value: "full", label: "Full width", icon: Square, description: "The open message replaces the list." },
                { value: "by_account", label: "Grouped by account", icon: Users, description: "One group per mailbox." },
                { value: "by_action", label: "Grouped by action", icon: LayoutList, description: "Grouped by what each message needs." },
                { value: "chronological", label: "Chronological", icon: Rows3, description: "Newest first under date headings, in Focus too. Security review stays apart." },
              ]} />
            </div>
          </Card>
          <Card title="AI">
            <div className="divide-y divide-line">
              <Toggle label="AI features" checked={prefs.aiEnabled !== false} onChange={aiEnabled => patch.mutate({ aiEnabled })} description="Summaries, suggested drafts and Focus. With this off, the app opens to Inbox. Security scanning still runs." />
              <Toggle label="Personalization" checked={prefs.personalizationEnabled !== false} onChange={personalizationEnabled => patch.mutate({ personalizationEnabled })} description="Ranks Focus using how often you write to and reply to each sender, who you've starred or ignored, and the importance feedback you give. It's kept to your account and isn't used for anyone else." />
            </div>
            <div className="mt-3 max-w-xs"><Field label="Tone for suggested drafts"><select className={inputClass} value={prefs.tone ?? "neutral"} onChange={e => patch.mutate({ tone: e.target.value })}><option value="neutral">Neutral</option><option value="warm">Warm</option><option value="brief">Brief</option><option value="formal">Formal</option></select></Field></div>
            <p className="mt-3 text-[13px] text-muted">Which AI model handles your mail is in the <Link href="/app/privacy" className="font-medium text-accent underline underline-offset-2">Privacy Center</Link>.</p>
          </Card>
          <Sections prefs={prefs} />
          <Hours key={JSON.stringify([prefs.workingHours, prefs.quietHours, prefs.timeZone])} prefs={prefs} />
          <Alerts prefs={prefs} />
        </div>
      )}
    </>
  );
}
