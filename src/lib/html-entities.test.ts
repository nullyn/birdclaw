import { describe, expect, it } from "vitest";
import { decodeHtmlEntities } from "./html-entities";

describe("decodeHtmlEntities", () => {
	it("decodes &amp; → &", () => {
		expect(decodeHtmlEntities("you &amp; me")).toBe("you & me");
	});

	it("decodes &gt; → >", () => {
		expect(decodeHtmlEntities("3 &gt; 2")).toBe("3 > 2");
	});

	it("decodes &lt; → <", () => {
		expect(decodeHtmlEntities("x &lt; 5")).toBe("x < 5");
	});

	it("decodes numeric &#39; → '", () => {
		expect(decodeHtmlEntities("&#39;hello&#39;")).toBe("'hello'");
	});

	it("decodes hex &#x27; → '", () => {
		expect(decodeHtmlEntities("&#x27;hello&#x27;")).toBe("'hello'");
	});

	it("leaves unknown entities unchanged", () => {
		expect(decodeHtmlEntities("&zzz; unknown")).toBe("&zzz; unknown");
	});

	it("returns text with no entities as-is", () => {
		expect(decodeHtmlEntities("plain text")).toBe("plain text");
	});

	it("decodes multiple entities in one string", () => {
		expect(decodeHtmlEntities("A &amp; B &gt; C &lt; D")).toBe("A & B > C < D");
	});

	it("decodes &quot; and &nbsp;", () => {
		expect(decodeHtmlEntities('"hello" &nbsp; world')).toBe(
			'"hello" \u00a0 world',
		);
	});

	it("ignores invalid numeric code points gracefully", () => {
		expect(decodeHtmlEntities("&#x110000; extra")).toBe("&#x110000; extra");
	});
});
