"use client";

import { useState } from "react";
import { Button } from "@usesend/ui/src/button";
import { Input } from "@usesend/ui/src/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@usesend/ui/src/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@usesend/ui/src/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";
import { Plus } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { api } from "~/trpc/react";

export default function AddContactsToSegment({
  segmentId,
  existingContactIds,
}: {
  segmentId: string;
  existingContactIds: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const [contactBookId, setContactBookId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const debouncedSetSearch = useDebouncedCallback((v: string) => {
    setSearch(v);
  }, 400);

  const { data: contactBooks } = api.contacts.getContactBooks.useQuery({});

  const { data: contactsPage, isLoading } = api.contacts.contacts.useQuery(
    { contactBookId, search: search || undefined, page: 1 },
    { enabled: !!contactBookId },
  );

  const utils = api.useUtils();
  const addMutation = api.segment.addContacts.useMutation({
    onSuccess: (result) => {
      utils.segment.listContacts.invalidate({ segmentId });
      utils.segment.list.invalidate();
      toast.success(`Added ${result.count} contact${result.count === 1 ? "" : "s"}`);
      setSelected(new Set());
      setOpen(false);
    },
    onError: (error) => toast.error(error.message),
  });

  const candidates = (contactsPage?.contacts ?? []).filter(
    (c) => !existingContactIds.has(c.id),
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSelected(new Set());
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus className="h-4 w-4 mr-1" />
          Add contacts
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Add contacts to this segment</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Select value={contactBookId} onValueChange={setContactBookId}>
            <SelectTrigger>
              {contactBooks?.find((b) => b.id === contactBookId)?.name ??
                "Select a contact book"}
            </SelectTrigger>
            <SelectContent>
              {contactBooks?.map((book) => (
                <SelectItem key={book.id} value={book.id}>
                  {book.name}{" "}
                  <span className="text-xs text-muted-foreground ml-2">
                    {book._count.contacts} contacts
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {contactBookId ? (
            <>
              <Input
                placeholder="Search by name or email"
                onChange={(e) => debouncedSetSearch(e.target.value)}
              />
              <div className="border rounded-lg max-h-[320px] overflow-y-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10" />
                      <TableHead>Email</TableHead>
                      <TableHead>Name</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center py-6">
                          <Spinner className="w-5 h-5 mx-auto" />
                        </TableCell>
                      </TableRow>
                    ) : candidates.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={3}
                          className="text-center py-6 text-sm text-muted-foreground"
                        >
                          No contacts to add from this book.
                        </TableCell>
                      </TableRow>
                    ) : (
                      candidates.map((contact) => (
                        <TableRow
                          key={contact.id}
                          className="cursor-pointer"
                          onClick={() => toggle(contact.id)}
                        >
                          <TableCell>
                            <input
                              type="checkbox"
                              checked={selected.has(contact.id)}
                              onChange={() => toggle(contact.id)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </TableCell>
                          <TableCell className="text-sm">
                            {contact.email}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {[contact.firstName, contact.lastName]
                              .filter(Boolean)
                              .join(" ") || "—"}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            disabled={selected.size === 0 || addMutation.isPending}
            onClick={() =>
              addMutation.mutate({
                segmentId,
                contactIds: Array.from(selected),
              })
            }
          >
            {addMutation.isPending
              ? "Adding…"
              : `Add ${selected.size || ""} selected`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
