/**
 * Synthetic training text, hand-written intents expanded by slot filling. Same author as the rule engine and the small
 * `adversarial` corpus set, so that set can't judge this model, and an earlier draft even shared phrases with it. Only
 * HOLDOUT (test-fixtures/holdout.ts), written without sight of this file, is a fair test. A real model needs a consented
 * or licensed corpus; see docs/STATUS.md.
 */
const pick = <T,>(xs: T[], i: number) => xs[i % xs.length]!;
const VENDOR = ["our supplier", "the vendor", "the contractor", "our partner", "the agency", "the distributor"];
const WHEN = ["today", "before close of business", "this afternoon", "by end of day", "before the weekend", "first thing tomorrow"];
const SOFT = ["could you", "would you mind", "can you", "please", "I need you to", "when you get this, please"];
const AWAY = ["I'm travelling", "I'm between meetings", "I'm boarding shortly", "I'm in a workshop all day", "I'm on a poor connection", "I'm with the board"];
const SETTLE = ["settle the balance", "take care of the outstanding amount", "sort out the remaining balance", "clear the open item", "release the funds", "process the transfer", "make the payment"];
const PORTAL = ["portal", "workspace", "dashboard", "account page", "secure area", "member area", "file viewer"];
const OPEN = ["go to", "visit", "open", "use", "try"];
const REWORD = ["restructure", "system migration", "change of auditors", "merger", "banking review", "rebrand"];
const ROLE = ["flexible role", "remote opportunity", "part-time position", "contract position", "exciting opening", "side role"];

const MALICIOUS: ((i: number) => string)[] = [
  i => `${pick(SOFT, i)} ${pick(SETTLE, i + 1)} for ${pick(VENDOR, i + 2)} ${pick(WHEN, i + 3)}? ${pick(AWAY, i + 4)} and will explain later.`,
  i => `${pick(AWAY, i)}. ${pick(VENDOR, i + 1)} is waiting on us, so ${pick(SOFT, i + 2)} ${pick(SETTLE, i + 3)} ${pick(WHEN, i + 4)}. Let's not loop anyone else in for the moment.`,
  i => `Are you around? ${pick(SOFT, i)} ${pick(SETTLE, i + 1)} for me. I'll send the particulars as soon as I hear back from you.`,
  i => `Because of the ${pick(REWORD, i)}, invoices from ${pick(VENDOR, i + 1)} are now collected by another company in the group. The new instructions are enclosed.`,
  i => `As part of the ${pick(REWORD, i)}, we have a new entity handling receivables. Direct future settlements there, starting ${pick(WHEN, i + 1)}.`,
  i => `Due to our ${pick(REWORD, i)}, the remit-to information on file is out of date. Kindly use the details in the attached letter for all open items.`,
  i => `Our ${pick(PORTAL, i)} has changed address. ${pick(OPEN, i + 1)} the link below and your session will be restored.`,
  i => `Your documents are ready in the ${pick(PORTAL, i)}. ${pick(OPEN, i + 1)} the link to view them. Access expires soon.`,
  i => `Your benefits summary was published to the ${pick(PORTAL, i)}. ${pick(OPEN, i + 1)} it, since the copy expires this week.`,
  i => `We noticed unusual activity. To keep things running smoothly, ${pick(OPEN, i)} your ${pick(PORTAL, i + 1)} and review your details.`,
  i => `Your subscription upgrade went through. If that wasn't intended, our staff can reverse it when you ring the number below.`,
  i => `Your order has been processed and your card was charged. If you did not make this purchase, speak to an agent on the number below.`,
  i => `Your annual plan renews automatically. To stop it, ring our billing desk on the number below.`,
  i => `Your background looks like a fit for a ${pick(ROLE, i)}. Reply with a scan of your driving licence and we can begin right away.`,
  i => `We have a ${pick(ROLE, i)} that suits you. Share a copy of your passport and your bank details so that payroll can set you up.`,
  i => `One more step before we close: the deposit should go to the account in the enclosed note, not the one from last time.`,
  i => `Further to my last email, accounts asked that this one be paid to the account on the enclosed page instead of the usual one.`,
  i => `Good news, your refund has been approved. Confirm your details in the ${pick(PORTAL, i)} so that we can release it.`,
];
const BENIGN: ((i: number) => string)[] = [
  i => `Thanks for the workshop on Monday. Could you send over the scope for phase two when you have a moment? The board meets next ${pick(["Friday", "Tuesday", "Thursday"], i)}.`,
  i => `Attached are the notes from today's meeting. Nothing urgent, but let me know if I missed anything about the ${pick(["launch", "rebrand", "packaging", "website"], i)}.`,
  i => `Can we move our call to ${pick(["3pm", "Thursday", "next week", "tomorrow morning"], i)}? Something came up on my side.`,
  i => `Invoice ${1000 + i} for this month's retainer is attached. Payment terms are the same as usual, net 30. Thanks for your business.`,
  i => `Remittance advice attached for invoice ${2000 + i}. Payment was made today to your usual account. Let me know if you don't see it.`,
  i => `Your statement for this month is now available. There is nothing you need to do. Thank you for being a customer.`,
  i => `Here's the draft of the proposal. I've included the budget section we talked about. Happy to walk through it on a call.`,
  i => `Please review the redlines on the contract. Our legal team had a couple of small comments on the indemnity section.`,
  i => `Your appointment is confirmed for ${pick(["Tuesday at 9:30", "Friday at 2pm", "the 18th at noon"], i)}. Reply to this message to reschedule.`,
  i => `Your order has shipped and should arrive by ${pick(["Friday", "Monday", "next week"], i)}. You can track it from your account.`,
  i => `Your receipt from ${pick(["the bookshop", "the cafe", "Fontworks", "the print shop"], i)}. Thanks for your purchase.`,
  i => `Are you coming on ${pick(["Sunday", "Saturday", "Friday"], i)}? We're making lasagne. Let us know so we can plan.`,
  i => `This week's issue covers type systems, pricing experiments and why grids came back. Unsubscribe any time.`,
  i => `A new pull request was opened in your repository. Your build passed. View the details in your dashboard.`,
  i => `I'm travelling next week so replies may be slow. Sam is covering anything urgent while I'm away.`,
  i => `We're doing a system migration this weekend. The intranet will be down Saturday morning. No action needed.`,
  i => `We finished the rebrand. Here are the new logos and colours for your files. Let me know if you need other formats.`,
  i => `We've agreed the retainer for next year. Finance will send the usual paperwork when it's ready, no rush at all.`,
  i => `The vendor sent their quote. It's a little higher than last year, so let's discuss it at Thursday's review before deciding.`,
  i => `Our team is hiring for a designer. If you know anyone good, send them my way. The posting is on our website.`,
  i => `Reminder that expense reports are due at the end of the month. Use the usual form on the intranet.`,
];

export function trainingSet(perTemplate = 18): { text: string; y: 0 | 1 }[] {
  const out: { text: string; y: 0 | 1 }[] = [];
  for (const t of MALICIOUS) for (let i = 0; i < perTemplate; i++) out.push({ text: t(i * 7 + 1), y: 1 });
  for (const t of BENIGN) for (let i = 0; i < perTemplate; i++) out.push({ text: t(i), y: 0 });
  return out;
}
