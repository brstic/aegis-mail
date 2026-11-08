/**
 * Synthetic mail with labelled relevance, for measuring semantic search. Every address, name and company is made up. Queries are
 * written to share as few words as possible with the mail they should find, because word search already covers the case where they do.
 * It's small and was written by one author, so a score here is a sanity check on this model and threshold, not a claim about real mailboxes.
 */
export interface SemanticDoc { id: string; subject: string; text: string }
export interface SemanticQuery { q: string; relevant: string[] }

export const SEMANTIC_DOCS: SemanticDoc[] = [
  { id: "bank-1", subject: "Vendor update", text: "Please update the beneficiary account for our invoices. The new IBAN applies from next month." },
  { id: "bank-2", subject: "Remittance instructions", text: "We have moved our receivables to a different institution, so future remittances should go to the sort code below." },
  { id: "resched-1", subject: "Thursday", text: "Something came up. Could we push the sync to Friday afternoon instead?" },
  { id: "resched-2", subject: "Our catch-up", text: "I'm double booked at ten. Is there another slot that works next week?" },
  { id: "sign-1", subject: "Agreement for countersignature", text: "Attached is the final version. Please countersign and return by the end of the week." },
  { id: "flight-1", subject: "Your itinerary", text: "You're confirmed on the 09:40 to Lisbon, seat 14C. Boarding closes twenty minutes before departure." },
  { id: "complaint-1", subject: "Order 4471", text: "My parcel arrived two weeks after the date you promised and the box was crushed. I'm very unhappy with this." },
  { id: "job-1", subject: "Designer role", text: "I'd love to be considered for the opening on your team. My CV and portfolio are attached." },
  { id: "outage-1", subject: "API errors", text: "Production has been returning 503 all morning and customers can't log in. The on-call engineer is looking at it." },
  { id: "refund-1", subject: "Duplicate charge", text: "You billed my card twice for the same subscription. I'd like my money back for the extra one." },
  { id: "lease-1", subject: "Premises from January", text: "The landlord has sent new terms for the office, with rent going up four percent when the current term ends." },
  { id: "lunch-1", subject: "Sam's last week", text: "Let's take Sam out for tacos on Wednesday before they go. Everyone's invited, I'll book a table." },
  { id: "tax-1", subject: "For your filing", text: "Attached are my W-2 and two 1099s for the year. Let me know if the preparer needs anything else." },
  { id: "leaving-1", subject: "Dana", text: "Dana has handed in her notice. Her final day is the 28th, and we need to plan a handover of her clients." },
  { id: "speak-1", subject: "Summit in May", text: "We would be honored to have you give a keynote at our annual summit in Denver. Travel is covered." },
  { id: "budget-1", subject: "Renovation costs", text: "We've spent forty percent more than planned on the renovation, and the contractor expects more overruns." },
  { id: "pw-1", subject: "Sign-in help", text: "I can't get into my account and the link to set new credentials never arrives." },
  { id: "newsletter-1", subject: "Five ways to sleep better", text: "This week: morning light, a cooler bedroom and why you should put your phone away." },
  { id: "sale-1", subject: "Autumn sale", text: "Thirty percent off all jackets and boots this weekend only. Shop now while stocks last." },
  { id: "school-1", subject: "Field trip", text: "The year five class visits the science museum on Tuesday. Packed lunches and a signed permission slip, please." },
  { id: "vet-1", subject: "Biscuit's booster", text: "Biscuit is due for his annual shots. We have appointments on Monday and Thursday at the clinic." },
  { id: "garden-1", subject: "Allotment", text: "The tomatoes have blight again, so I've pulled the worst plants and sprayed the rest." },
  { id: "invoice-ok-1", subject: "Invoice 2231", text: "Thanks for your work in October. The amount of $4,200 is due within thirty days as usual." },
  { id: "roadmap-1", subject: "Planning session", text: "Here are the slides for next quarter's priorities. We'll go through the product themes together." },
  { id: "security-1", subject: "New sign-in", text: "We noticed a sign-in to your account from a new device in Toronto. If this was you, there's nothing to do." },
  { id: "hiring-1", subject: "Interview feedback", text: "The panel liked her system design answers but thought the coding exercise was weak. Shall we make an offer?" },
  { id: "insurance-1", subject: "Policy renewal", text: "Your home cover renews on the first of March. The premium rises by twelve dollars a month." },
  { id: "travel-1", subject: "Hotel", text: "Your room at the Harbor Inn is reserved for two nights. Check in from three in the afternoon." },
  { id: "doc-1", subject: "Handbook edits", text: "I've tracked my changes on the staff handbook, mostly the sections on remote work and expenses." },
  { id: "payroll-1", subject: "Direct deposit", text: "I opened an account elsewhere and need my pay to go there from the next cycle. Details to follow." },
];

export const SEMANTIC_QUERIES: SemanticQuery[] = [
  { q: "the supplier who wanted a bank detail change", relevant: ["bank-1", "bank-2"] },
  { q: "someone asking to move our meeting", relevant: ["resched-1", "resched-2"] },
  { q: "contract that needs my signature", relevant: ["sign-1"] },
  { q: "flight booking confirmation", relevant: ["flight-1"] },
  { q: "customer complaining about a late delivery", relevant: ["complaint-1"] },
  { q: "person applying for a job", relevant: ["job-1"] },
  { q: "the website is down", relevant: ["outage-1"] },
  { q: "someone wants a refund", relevant: ["refund-1"] },
  { q: "office rent increase", relevant: ["lease-1"] },
  { q: "farewell meal for a colleague", relevant: ["lunch-1"] },
  { q: "tax documents for the accountant", relevant: ["tax-1"] },
  { q: "an employee resigning", relevant: ["leaving-1"] },
  { q: "invitation to speak at a conference", relevant: ["speak-1"] },
  { q: "project going over budget", relevant: ["budget-1"] },
  { q: "user locked out of their login", relevant: ["pw-1"] },
  { q: "staff member changing where their salary is paid", relevant: ["payroll-1"] },
];

/** Nothing in the set is about these. A good result is finding nothing above the floor. */
export const SEMANTIC_OFF_TOPIC: string[] = ["recipe for sourdough bread", "how to fix a flat bicycle tyre", "best hiking trails in Patagonia", "quantum computing lecture notes"];
