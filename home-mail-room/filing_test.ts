import { assertEquals } from "jsr:@std/assert@1";
import {
  cleanSegment,
  destinationPath,
  filenameProblem,
  matchSender,
  parseLetterDate,
  senderName,
} from "./filing.ts";

Deno.test("parseLetterDate reads the shapes letters use, day first", () => {
  const cases: [string, string | null][] = [
    ["18 May 2023", "2023-05-18"],
    ["22 Aug 2024", "2024-08-22"],
    ["22 August 2025", "2025-08-22"],
    ["1st March 2024", "2024-03-01"],
    ["08/10/2024", "2024-10-08"],
    ["11/11/25", "2025-11-11"],
    ["3.4.2024", "2024-04-03"],
    ["2024-08-22", "2024-08-22"],
    ["31/02/2024", null],
    ["next Tuesday", null],
    ["", null],
  ];
  for (const [raw, iso] of cases) {
    assertEquals(parseLetterDate(raw), iso, raw);
  }
});

Deno.test("cleanSegment makes text safe as one path segment", () => {
  assertEquals(cleanSegment("  Thames   Water "), "Thames Water");
  assertEquals(cleanSegment("A/B: Ltd."), "A-B- Ltd");
  assertEquals(cleanSegment("../.."), "");
});

Deno.test("destinationPath files under the sender, named by date", () => {
  assertEquals(
    destinationPath("/cab", {
      sender: "Thames Water",
      date: "2023-05-18",
      documentType: "bill",
      title: "",
    }),
    "/cab/Thames Water/2023-05-18 Thames Water bill.pdf",
  );
  assertEquals(
    destinationPath("/cab", {
      sender: "Clydesdale Bank",
      date: "2024-08-22",
      documentType: "other",
      title: "Mortgage details",
    }),
    "/cab/Clydesdale Bank/2024-08-22 Clydesdale Bank Mortgage details.pdf",
  );
});

Deno.test("destinationPath uses a filename given in place of the generated one", () => {
  assertEquals(
    destinationPath("/cab", {
      sender: "Thames Water",
      date: "2023-05-18",
      documentType: "bill",
      title: "",
      filename: "Water bill May.pdf",
    }),
    "/cab/Thames Water/Water bill May.pdf",
  );
});

Deno.test("filenameProblem refuses names that are not one plain PDF file name", () => {
  assertEquals(filenameProblem("Water bill.pdf"), null);
  assertEquals(filenameProblem("Water bill.PDF"), null);
  for (const bad of ["Water bill", "../x.pdf", "a/b.pdf", ".pdf", " x.pdf"]) {
    assertEquals(typeof filenameProblem(bad), "string", bad);
  }
});

Deno.test("matchSender finds the cabinet folder whatever the case or spacing", () => {
  const folders = ["Thames Water", "Halifax Bank", "Brighton Council"];
  assertEquals(matchSender("thames  water", folders), "Thames Water");
  assertEquals(matchSender(" HALIFAX BANK", folders), "Halifax Bank");
  assertEquals(matchSender("Halifax", folders), null);
  assertEquals(matchSender("", folders), null);
});

Deno.test("senderName title-cases a sender read all in capitals or all in lower case", () => {
  const cases: [string, string][] = [
    ["LONDON BOROUGH OF HACKNEY", "London Borough Of Hackney"],
    ["BLACK KATZ N1 LETTINGS & PROPERTY", "Black Katz N1 Lettings & Property"],
    ["ROYAL-MAIL", "Royal-Mail"],
    ["thames water", "Thames Water"],
    ["bt", "Bt"],
    ["andrews & arnold ltd.", "Andrews & Arnold Ltd."],
  ];
  for (const [raw, want] of cases) assertEquals(senderName(raw), want, raw);
});

Deno.test("senderName keeps mixed case, and capitals of under five letters", () => {
  const cases = [
    "HM Revenue & Customs",
    "Post Office Ltd.",
    "eBay",
    "HMRC",
    "EDF",
    "O2 UK",
    "",
    "123",
  ];
  for (const raw of cases) assertEquals(senderName(raw), raw, raw);
});
