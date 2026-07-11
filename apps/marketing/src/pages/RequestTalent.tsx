import { useState } from "react";
import type { FormEvent } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useSeo } from "@/lib/seo";
import { publicApiFetch, PublicApiError } from "@/lib/api";
import { Section, Eyebrow } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { Label, Input, TextArea, Select } from "@/components/ui/Field";
import { INDUSTRIES } from "@/lib/content";

interface RequestTalentForm {
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  industryName: string;
  city: string;
  state: string;
  message: string;
}

const EMPTY: RequestTalentForm = {
  companyName: "",
  contactName: "",
  email: "",
  phone: "",
  industryName: "",
  city: "",
  state: "",
  message: "",
};

export default function RequestTalent() {
  useSeo({
    title: "Request Talent",
    description:
      "Tell us about your staffing needs — Temporary, Direct Hire, Skilled Trades, or Project Staffing — and our team will follow up within one business day.",
    path: "/request-talent",
  });

  const [form, setForm] = useState<RequestTalentForm>(EMPTY);
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      await publicApiFetch("/request-talent", {
        method: "POST",
        body: JSON.stringify({
          contactName: form.contactName,
          companyName: form.companyName || undefined,
          email: form.email,
          phone: form.phone || undefined,
          industryName: form.industryName || undefined,
          city: form.city || undefined,
          state: form.state ? form.state.toUpperCase() : undefined,
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
      <Section tone="ink" className="pt-28">
        <div className="max-w-2xl">
          <Eyebrow>Request Talent</Eyebrow>
          <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">Tell us what you need</h1>
          <p className="mt-6 text-lg text-ink-foreground/70">
            Share a few details about your staffing needs and a member of our team will follow up within one
            business day — no obligation.
          </p>
        </div>
      </Section>

      <Section>
        <div className="mx-auto max-w-2xl">
          {status === "success" ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-10 text-center">
              <CheckCircle2 className="h-10 w-10 text-primary" />
              <h2 className="text-xl font-semibold">Request received</h2>
              <p className="text-sm text-muted-foreground">
                Thanks — a member of our team will reach out shortly to discuss your staffing needs.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div>
                  <Label htmlFor="contactName" required>
                    Your name
                  </Label>
                  <Input
                    id="contactName"
                    required
                    value={form.contactName}
                    onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="companyName" required>
                    Company
                  </Label>
                  <Input
                    id="companyName"
                    required
                    value={form.companyName}
                    onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                  />
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
                  <Label htmlFor="industryName">Industry</Label>
                  <Select
                    id="industryName"
                    value={form.industryName}
                    onChange={(e) => setForm({ ...form, industryName: e.target.value })}
                  >
                    <option value="">Select an industry</option>
                    {INDUSTRIES.map((ind) => (
                      <option key={ind.slug} value={ind.name}>
                        {ind.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="city">City</Label>
                    <Input id="city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                  </div>
                  <div>
                    <Label htmlFor="state">State</Label>
                    <Input
                      id="state"
                      maxLength={2}
                      placeholder="IL"
                      value={form.state}
                      onChange={(e) => setForm({ ...form, state: e.target.value })}
                    />
                  </div>
                </div>
              </div>
              <div>
                <Label htmlFor="message">Tell us about your staffing needs</Label>
                <TextArea
                  id="message"
                  placeholder="Role(s), quantity, timeline, and any specific requirements"
                  value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                />
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
              <Button type="submit" size="lg" disabled={status === "submitting"} className="w-full">
                {status === "submitting" && <Loader2 className="h-4 w-4 animate-spin" />}
                Submit Request
              </Button>
            </form>
          )}
        </div>
      </Section>
    </>
  );
}
