import { useState } from "react";
import type { FormEvent } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useSeo } from "@/lib/seo";
import { publicApiFetch, PublicApiError } from "@/lib/api";
import { Section, Eyebrow } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { Label, Input, TextArea } from "@/components/ui/Field";
import { PHOTOS } from "@/lib/photos";

interface ContactForm {
  contactName: string;
  companyName: string;
  email: string;
  phone: string;
  message: string;
}

const EMPTY: ContactForm = { contactName: "", companyName: "", email: "", phone: "", message: "" };

export default function Contact() {
  useSeo({
    title: "Contact Us",
    description: "Get in touch with our team — questions, partnerships, or anything else.",
    path: "/contact",
  });

  const [form, setForm] = useState<ContactForm>(EMPTY);
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      await publicApiFetch("/contact", {
        method: "POST",
        body: JSON.stringify({
          contactName: form.contactName,
          companyName: form.companyName || undefined,
          email: form.email,
          phone: form.phone || undefined,
          message: form.message || undefined,
        }),
      });
      setStatus("success");
      setForm(EMPTY);
    } catch (err) {
      setStatus("error");
      setError(err instanceof PublicApiError ? err.message : "Something went wrong. Please try again.");
    }
  }

  return (
    <>
      <Section tone="ink" className="pt-28" backgroundPhoto={PHOTOS.corporateBuildingExterior}>
        <div className="max-w-2xl">
          <Eyebrow>Contact</Eyebrow>
          <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">Let's talk</h1>
          <p className="mt-6 text-lg text-ink-foreground/70">
            Questions about our services, a partnership idea, or anything else — send us a message and a member of
            our team will follow up.
          </p>
        </div>
      </Section>

      <Section>
        <div className="mx-auto max-w-xl">
          {status === "success" ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-10 text-center">
              <CheckCircle2 className="h-10 w-10 text-primary" />
              <h2 className="text-xl font-semibold">Message received</h2>
              <p className="text-sm text-muted-foreground">
                Thanks for reaching out — a member of our team will be in touch shortly.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <Label htmlFor="contactName" required>
                  Full name
                </Label>
                <Input
                  id="contactName"
                  required
                  value={form.contactName}
                  onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="companyName">Company</Label>
                <Input id="companyName" value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="email" required>
                  Email
                </Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="message">Message</Label>
                <TextArea id="message" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" size="lg" disabled={status === "submitting"} className="w-full">
                {status === "submitting" && <Loader2 className="h-4 w-4 animate-spin" />}
                Send Message
              </Button>
            </form>
          )}
        </div>
      </Section>
    </>
  );
}
