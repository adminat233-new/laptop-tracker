# Fix Pairing UI and Move "Get App" Button

The pairing interaction between the Laptop and Phone roles is currently broken because the necessary JavaScript functions and event listeners are missing. Additionally, the "Get App" section needs to be moved to the top-right corner as a button.

## Proposed Changes

### [Component Name] UI/UX Fixes

#### [MODIFY] [index.html](file:///C:/Users/Admin/Documents/Default Project/laptop-tracker/public/index.html)

- **Move "Get App" Button**: Move the mobile app download link to the top-right corner of the screen.
- **Add Missing Styles**: Add a `.hidden` utility class and styles for the new "Get App" button position.
- **Add Missing IDs**: Add `id="pair-title"` and `id="pair-subtitle"` to the hero section to support the pairing logic.
- **Implement `becomePhone()`**: Add the missing function to handle switching to the phone/control mode.
- **Wire up Event Listeners**: Add listeners for role selection buttons (`role-laptop-btn`, `role-phone-btn`) and the connection button (`connect-btn`).
- **Fix Missing Buttons in Laptop Section**: Add the "Copy Code" and "Share Link" buttons that are referenced in JS but missing in HTML.

## Verification Plan

### Manual Verification
- Open the landing page.
- Verify the "Get App" button is in the top-right corner.
- Click "Target Laptop" and verify it generates a pairing code.
- Click "Control Phone" and verify it shows the input fields for the code.
- Verify that entering a code and clicking "Establish Uplink" triggers the verification process.
