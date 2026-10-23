"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@usesend/ui/src/breadcrumb";
import { Button } from "@usesend/ui/src/button";
import { Input } from "@usesend/ui/src/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";
import Spinner from "@usesend/ui/src/spinner";
import { Badge } from "@usesend/ui/src/badge";
import { toast } from "@usesend/ui/src/toaster";
import { DeleteResource } from "~/components/DeleteResource";
import { Send, Trash2, X, Check, Pencil } from "lucide-react";
import { api } from "~/trpc/react";
import AddContactsToSegment from "./add-contacts-to-segment";

export default function SegmentDetailPage({
  params,
}: {
  params: Promise<{ segmentId: string }>;
}) {
  const { segmentId } = use(params);
  const router = useRouter();
  const utils = api.useUtils();

  const [isRenaming, setIsRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const { data: segment, isLoading: segmentLoading } = api.segment.get.useQuery({
    segmentId,
  });
  const { data: contacts, isLoading: contactsLoading } =
    api.segment.listContacts.useQuery({ segmentId });

  const renameMutation = api.segment.rename.useMutation({
    onSuccess: () => {
      utils.segment.get.invalidate({ segmentId });
      utils.segment.list.invalidate();
      setIsRenaming(false);
    },
    onError: (error) => toast.error(error.message),
  });

  const deleteMutation = api.segment.delete.useMutation({
    onSuccess: () => {
      utils.segment.list.invalidate();
      router.push("/contacts/segments");
    },
    onError: (error) => toast.error(error.message),
  });

  const removeMutation = api.segment.removeContacts.useMutation({
    onSuccess: () => {
      utils.segment.listContacts.invalidate({ segmentId });
      utils.segment.list.invalidate();
      toast.success("Removed from segment");
    },
    onError: (error) => toast.error(error.message),
  });

  const createAudienceMutation = api.segment.createCampaignAudience.useMutation({
    onSuccess: (result) => {
      toast.success(
        `Created a contact book with ${result.count} contact${result.count === 1 ? "" : "s"}. Point a campaign at it.`,
      );
      router.push("/campaigns");
    },
    onError: (error) => toast.error(error.message),
  });

  if (segmentLoading || !segment) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-6 h-6" />
      </div>
    );
  }

  const existingContactIds = new Set((contacts ?? []).map((c) => c.id));

  return (
    <div>
      <div className="flex justify-between items-center">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/contacts/segments" className="text-xl">
                  Segments
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="text-xl" />
            <BreadcrumbItem>
              {isRenaming ? (
                <div className="flex items-center gap-1">
                  <Input
                    className="h-8 w-[220px]"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    autoFocus
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      renameMutation.mutate({ segmentId, name: nameDraft })
                    }
                    disabled={!nameDraft.trim() || renameMutation.isPending}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setIsRenaming(false)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <BreadcrumbPage className="text-xl flex items-center gap-2">
                  {segment.name}
                  <button
                    aria-label="Rename segment"
                    onClick={() => {
                      setNameDraft(segment.name);
                      setIsRenaming(true);
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => createAudienceMutation.mutate({ segmentId })}
            disabled={createAudienceMutation.isPending}
          >
            <Send className="h-4 w-4 mr-1" />
            {createAudienceMutation.isPending
              ? "Creating…"
              : "Use for a campaign"}
          </Button>
          <AddContactsToSegment
            segmentId={segmentId}
            existingContactIds={existingContactIds}
          />
          <DeleteResource
            title="Delete segment"
            resourceName={segment.name}
            descriptionBody={`Deletes "${segment.name}". The contacts themselves are not deleted.`}
            isLoading={deleteMutation.isPending}
            onConfirm={() => deleteMutation.mutate({ segmentId })}
            confirmLabel="Delete segment"
            trigger={
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                aria-label="Delete segment"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            }
          />
        </div>
      </div>

      <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
        &quot;Use for a campaign&quot; snapshots the {contacts?.length ?? 0}{" "}
        contact{contacts?.length === 1 ? "" : "s"} below into a new contact
        book, since campaigns are sent to a contact book. Create the
        campaign, then pick that new book as its audience.
      </p>

      <div className="border rounded-xl shadow mt-6">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="rounded-tl-xl">Email</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="rounded-tr-xl" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {contactsLoading ? (
              <TableRow className="h-32">
                <TableCell colSpan={4} className="text-center py-4">
                  <Spinner className="w-6 h-6 mx-auto" />
                </TableCell>
              </TableRow>
            ) : !contacts || contacts.length === 0 ? (
              <TableRow className="h-32">
                <TableCell colSpan={4} className="text-center py-4">
                  No contacts in this segment yet. Use &quot;Add
                  contacts&quot; to pull some in from a contact book.
                </TableCell>
              </TableRow>
            ) : (
              contacts.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell className="text-sm">{contact.email}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {[contact.firstName, contact.lastName]
                      .filter(Boolean)
                      .join(" ") || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={contact.subscribed ? "outline" : "destructive"}>
                      {contact.subscribed ? "Subscribed" : "Unsubscribed"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Remove from segment"
                      onClick={() =>
                        removeMutation.mutate({
                          segmentId,
                          contactIds: [contact.id],
                        })
                      }
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
