// Ported from the Roku app's tests/utils_test.brs ("Provider categories" and "The
// provider in use"), which use the real category names of the provider in use.
import { describe, expect, it } from "vitest";
import { categoryWanted, classifyCategory, is4KLabel, languageTurns, organizeCategories, takeTurns } from "../src/core/categories";

const c = (name: string) => classifyCategory(name, 2026);
const langs = ["en", "hi", "pa"];

describe("provider categories", () => {
  it("reads language codes and tidies names", () => {
    expect(c("EN | ACTION ★")).toMatchObject({ lang: "en", label: "Action" });
    expect(c("|IN| BOLLYWOOD 2024")).toMatchObject({ lang: "hi", label: "Bollywood 2024", isNew: false });
    expect(c("PUNJABI MOVIES")).toMatchObject({ lang: "pa", label: "Punjabi" });
    expect(c("AR | AFLAM").lang).toBe("other");
    expect(c("TAMIL MOVIES").lang).toBe("other");
    expect(c("PAKISTANI DRAMAS").lang).toBe("other");
    expect(c("SOUTH INDIAN HINDI DUBBED").lang).toBe("hi");
    expect(c("SOUTH INDIAN MOVIES").lang).toBe("other");
    expect(c("ACTION").lang).toBe("");
    expect(c("NETFLIX MOVIES").label).toBe("Netflix");
    expect(c("SCI-FI & FANTASY")).toMatchObject({ label: "Sci-Fi & Fantasy", lang: "" });
  });
  it("spots new releases and kids", () => {
    expect(c("NEW RELEASES 2026").isNew).toBe(true);
    expect(c("MOVIES 2025").isNew).toBe(true);
    expect(c("IN THEATERS NOW")).toMatchObject({ isNew: true, lang: "" });
    expect(c("EN - KIDS")).toMatchObject({ kids: true, label: "Kids" });
    expect(c("IN | ACTION").label).toBe("Hindi Action");
    expect(c("|UK| TOP 10 THIS WEEK").isNew).toBe(true);
    expect(c("4K UHD MOVIES").label).toBe("4K UHD");
    expect(c("EN | NETFLIX | DRAMA").label).toBe("Netflix · Drama");
  });
  it("keeps only the languages you watch, and orders them", () => {
    expect(categoryWanted({ lang: "" }, langs)).toBe(true);
    expect(categoryWanted({ lang: "other" }, langs)).toBe(false);
    expect(categoryWanted({ lang: "other" }, [])).toBe(true);
    const organized = organizeCategories(
      [
        { id: "1", name: "AR | ACTION" },
        { id: "2", name: "EN | DRAMA" },
        { id: "3", name: "IN | COMEDY" },
        { id: "4", name: "NEW RELEASES" },
        { id: "5", name: "HORROR" },
      ],
      langs,
      2026,
    );
    expect(organized.map((e) => e.id).join(",")).toBe("4,2,5,3");
    expect(takeTurns<number | string>([1, 2, 3], ["a"]).length).toBe(4);
  });
});

describe("the provider in use", () => {
  it("reads its names", () => {
    expect(c("EN ✪ ACTION [4K]")).toMatchObject({ lang: "en", label: "Action · 4K" });
    expect(c("EN ◉ TURKISH").lang).toBe("en");
    expect(c("CA ◉ QUEBECOISE").lang).toBe("other");
    expect(c("CA ◉ TÉLÉRÉALITÉS ET VARIÉTÉS").lang).toBe("other");
    expect(c("IN ✪ GUJARTI").lang).toBe("other");
    expect(c("IN ✪ MALAYALAM").lang).toBe("other");
    expect(c("IN ✪ PUNJABI")).toMatchObject({ lang: "pa", label: "Punjabi" });
    expect(c("IN ✪ BOLLYWOOD").lang).toBe("hi");
    expect(c("IN ◉ INDIAN").lang).toBe("hi");
    expect(c("VIP ✪ كأس العالم 2026").lang).toBe("other");
    expect(c("VIP ✪ FIFA World Cup 2026")).toMatchObject({ lang: "", label: "FIFA World Cup 2026", isNew: true });
    expect(c("EN ◉ TV SHOWS").label).toBe("TV Shows");
    expect(c("UK ◉ UK SERIES").label).toBe("UK Series");
    expect(c("FR ✪ ACTION").label).toBe("FR · Action");
    expect(c("EN ✪ BOX OFFICE").isNew).toBe(true);
    expect(c("EN ✪ MOVIE SERIES").label).toBe("Movie Series");
    expect(c("EN ✪ CONCERTS/MUSICAL").label).toBe("Concerts/Musical");
    expect(c("EN ✪ SCI-FI").label).toBe("Sci-Fi");
    expect(c("EN ◉ SERIES").label).toBe("English");
  });
  it("lets languages take turns, 4K last only when asked", () => {
    const turns = languageTurns(
      [
        { lang: "en", id: "1" },
        { lang: "en", id: "2" },
        { lang: "hi", id: "3" },
        { lang: "pa", id: "4" },
        { lang: "", id: "5" },
      ],
      langs,
    );
    expect(turns.map((e) => e.id).join(",")).toBe("1,3,4,2,5");
    expect(is4KLabel("Action · 4K")).toBe(true);
    expect(is4KLabel("Box Office")).toBe(false);
    const shown4k = organizeCategories(
      [
        { id: "1", name: "EN ✪ ACTION [4K]" },
        { id: "2", name: "EN ✪ ACTION" },
        { id: "3", name: "EN ✪ 4K [2024/2025]" },
      ],
      langs,
      2026,
      true,
    );
    expect(shown4k.map((e) => e.id).join(",")).toBe("2,1,3");
    expect(shown4k[2].isNew).toBe(false);
    const turns4k = languageTurns(
      [
        { lang: "en", id: "a", demoted: true },
        { lang: "en", id: "b", demoted: false },
      ],
      langs,
    );
    expect(turns4k.map((e) => e.id).join("")).toBe("ba");
    // The Q60 is 4K: without demotion, 4K new releases stay new.
    expect(organizeCategories([{ id: "3", name: "EN ✪ 4K [2024/2025]" }], langs, 2026)[0].isNew).toBe(true);
  });
});
