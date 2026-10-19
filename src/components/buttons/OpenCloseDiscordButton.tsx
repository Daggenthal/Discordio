import { DialogButton, Router } from "@decky/ui";
import { FaDiscord } from "react-icons/fa";

export function OpenDiscordButton() {
  return (
    <DialogButton onClick={() => Router.Navigate("/discord")} style={{ width: "100%" }}>
      <FaDiscord style={{ marginRight: "6px" }} />
      Open Discord
    </DialogButton>
  );
}
