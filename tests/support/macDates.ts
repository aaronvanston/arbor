/**
 * A date as macOS writes it. The app formats dates with the Mac's own ICU (its web view's), and the tests expect that.
 * Bun on Linux, where the checks also run, carries newer locale data that writes September as "Sept" and a range of
 * days without spaces ("14–20"), so a date a test compares is put in the Mac's form first.
 */
export const macDates = (text: string) => text.replace(/\bSept\b/g, 'Sep').replace(/(\d)–(\d)/g, '$1 – $2');
