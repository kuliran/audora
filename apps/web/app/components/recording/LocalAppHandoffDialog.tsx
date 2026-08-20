import { ExternalLink, Laptop } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { getLocalAppConversationUrl } from "~/lib/local-app-handoff";

interface LocalAppHandoffDialogProps {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function LocalAppHandoffDialog({
  conversationId,
  open,
  onOpenChange,
}: LocalAppHandoffDialogProps) {
  const appUrl = getLocalAppConversationUrl(conversationId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Laptop className="size-5" />
          </div>
          <DialogTitle>Open this conversation in Audora?</DialogTitle>
          <DialogDescription>
            Recording and transcription run in the local Mac app. Your browser
            may ask for permission to open Audora.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Not now
            </Button>
          </DialogClose>
          <Button asChild>
            <a href={appUrl} onClick={() => onOpenChange(false)}>
              Open Audora
              <ExternalLink className="size-4" />
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
