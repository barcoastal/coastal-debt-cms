// Google Apps Script: Auto-sync Auction Insights reports
// This script finds the latest Google Ads scheduled report by name
// and copies its data into the fixed target sheet.
//
// SETUP (one time only):
// 1. Go to https://script.google.com → New project
// 2. Paste this entire script
// 3. Click Run → select "syncAllReports" → Authorize when prompted
// 4. Click Triggers (clock icon on left) → Add Trigger:
//    - Function: syncAllReports
//    - Event source: Time-driven
//    - Type: Day timer
//    - Time: 6am to 7am (or whenever you want)
// 5. Save. Done — it runs daily forever.

// ============ CONFIGURATION ============
// Map each report name to its FIXED target sheet ID (from your CMS config)
const REPORT_CONFIG = [
  {
    searchName: "Auction insights report",
    targetSheetId: "1H2AfJsBgCVn30J31-Xz5dSq7DciTolOhRvqFrYf7no4"
  },
  {
    searchName: "RLSA | [Broad] - All Devices Auction insights report",
    targetSheetId: "158bfuGPE6t8TZOFj5aSO03haxDczFVs28flkNO9WJPo"
  },
  {
    searchName: "MCA-Debt | [exact-Phrase] - All Devices | IS18 Auction insights report",
    targetSheetId: "1UrzsNAFz0NIEsZqBBvJTJ9INy6ybeKQxPILLSWeeH0c"
  },
  {
    searchName: "Comp | [exact-Phrase] Auction insights report",
    targetSheetId: "140UCy0t4UoXNJMWa3iWFIp0rMuNgrBwz8WJus2dbQqg"
  },
  {
    searchName: "Business-Debt-Relief | [exact-Phrase] | IS4 Auction insights report",
    targetSheetId: "1VALidUB2h4F8qGPH-t4qBixHFLgO5FD4abby0VxeI_U"
  },
  {
    searchName: "Business-Bankrupyuncy | [Exact] | All - IS7 Auction insights report",
    targetSheetId: "1GrD1nje36xXvizSp_IkjfDOWmszXsUTSVl9gBSw0eUA"
  },
  {
    searchName: "Brand | [exact-Phrase] | IS2 Auction insights report",
    targetSheetId: "1czW7bcJbK3UNU6SyFhlL2suuVV0qnDToOdCJDVveJR0"
  }
];

// ============ MAIN FUNCTION ============
function syncAllReports() {
  const results = [];

  for (const config of REPORT_CONFIG) {
    try {
      const result = syncReport(config.searchName, config.targetSheetId);
      results.push(result);
      Logger.log(result);
    } catch (e) {
      const msg = "ERROR: " + config.searchName + " — " + e.message;
      results.push(msg);
      Logger.log(msg);
    }
  }

  // Log summary
  Logger.log("=== SYNC COMPLETE ===");
  results.forEach(r => Logger.log(r));
}

function syncReport(searchName, targetSheetId) {
  // Search for the latest file with this exact name
  const files = DriveApp.searchFiles(
    'title = "' + searchName.replace(/"/g, '\\"') + '" and mimeType = "application/vnd.google-apps.spreadsheet" and trashed = false'
  );

  // Collect all matches and find the newest one
  let latestFile = null;
  let latestDate = new Date(0);

  while (files.hasNext()) {
    const file = files.next();
    const created = file.getDateCreated();
    if (created > latestDate) {
      latestDate = created;
      latestFile = file;
    }
  }

  if (!latestFile) {
    return "SKIP: " + searchName + " — no file found in Drive";
  }

  const sourceId = latestFile.getId();

  // Don't copy if source IS the target (same file)
  if (sourceId === targetSheetId) {
    return "SKIP: " + searchName + " — latest file is already the target sheet";
  }

  // Open source and target
  const sourceSheet = SpreadsheetApp.openById(sourceId);
  const targetSheet = SpreadsheetApp.openById(targetSheetId);

  const sourceData = sourceSheet.getSheets()[0]; // first tab
  const targetData = targetSheet.getSheets()[0]; // first tab

  // Get all data from source (use getDisplayValues to preserve "10%" format instead of raw 0.10)
  const range = sourceData.getDataRange();
  const values = range.getDisplayValues();

  if (values.length === 0) {
    return "SKIP: " + searchName + " — source sheet is empty";
  }

  // Clear target and paste new data
  targetData.clear();
  targetData.getRange(1, 1, values.length, values[0].length).setValues(values);

  const dateStr = values.length > 1 ? values[1][0] : "unknown date";

  return "OK: " + searchName + " — copied " + values.length + " rows from " + dateStr + " (source: " + sourceId + ")";
}

// ============ MANUAL TEST ============
// Run this to test a single report sync
function testSingleSync() {
  const result = syncReport(
    "Business-Bankrupyuncy | [Exact] | All - IS7 Auction insights report",
    "1GrD1nje36xXvizSp_IkjfDOWmszXsUTSVl9gBSw0eUA"
  );
  Logger.log(result);
}
