import { FocusDemo } from "@/components/marketing/focus-demo";
import { PhishingDemo } from "@/components/marketing/phishing-demo";
import { Container, GitHubCta, OpenSourceLine, Section } from "@/components/marketing/primitives";
import { FilmChapters } from "@/film/dom/FilmChapters";

export default function HomePage() {
  return (
    <>
      <FilmChapters />
      <div className="after-film">
      <Section id="focus-demo" tone="surface" title="Try it." lead={<p>Select a message to see why it ranked where it did and what the security checks found. Everything here runs in your browser on made-up mail.</p>}>
        <FocusDemo />
      </Section>

      <Section id="phishing-demo" title="See what the AI caught." lead={<p>Pick a synthetic email. Each result lists what raised or lowered the risk, in plain language, so you can judge it yourself.</p>}>
        <PhishingDemo />
      </Section>

      <section aria-labelledby="start-title" className="bg-surface">
        <Container className="py-16 sm:py-24">
          <h2 id="start-title" className="mx-auto max-w-2xl text-center font-display text-[2.25rem] leading-[1.08] text-balance sm:text-[3.5rem]">An inbox that protects itself.</h2>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <GitHubCta />
          </div>
          <OpenSourceLine className="mt-5" />
        </Container>
      </section>
      </div>
    </>
  );
}
