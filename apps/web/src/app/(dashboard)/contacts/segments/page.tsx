"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@usesend/ui/src/dialog";
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
import { Plus, Layers, ChevronRight } from "lucide-react";
import { api } from "~/trpc/react";

function CreateSegmentDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const utils = api.useUtils();
  const router = useRouter();

  const createMutation = api.segment.create.useMutation({
    onSuccess: (segment) => {
      utils.segment.list.invalidate();
      setOpen(false);
      setName("");
      toast.success("Segment created");
      router.push(`/contacts/segments/${segment.id}`);
    },
    onError: (error: { message: string }) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-1" />
          Create segment
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a segment</DialogTitle>
        </DialogHeader>
        <Input
          placeholder="e.g. Opened last campaign"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <DialogFooter>
          <Button
            disabled={!name.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate({ name })}
          >
            {createMutation.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SegmentsPage() {
  const segmentsQuery = api.segment.list.useQuery();

  return (
    <div>
      <div className="flex justify-between items-center">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/contacts" className="text-xl">
                  Contact books
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="text-xl" />
            <BreadcrumbItem>
              <BreadcrumbPage className="text-xl">Segments</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <CreateSegmentDialog />
      </div>
      <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
        A segment is a named group of contacts pulled from any of your
        contact books. Build one, then send a campaign to exactly that
        group instead of a whole book.
      </p>

      <div className="border rounded-xl shadow mt-6">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="rounded-tl-xl">Name</TableHead>
              <TableHead>Contacts</TableHead>
              <TableHead className="rounded-tr-xl" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {segmentsQuery.isLoading ? (
              <TableRow className="h-32">
                <TableCell colSpan={3} className="text-center py-4">
                  <Spinner className="w-6 h-6 mx-auto" />
                </TableCell>
              </TableRow>
            ) : segmentsQuery.data?.length === 0 ? (
              <TableRow className="h-32">
                <TableCell colSpan={3} className="text-center py-4">
                  No segments yet.
                </TableCell>
              </TableRow>
            ) : (
              segmentsQuery.data?.map((segment) => (
                <TableRow key={segment.id}>
                  <TableCell>
                    <Link
                      href={`/contacts/segments/${segment.id}`}
                      className="flex items-center gap-2 font-medium hover:underline"
                    >
                      <Layers className="h-4 w-4 text-muted-foreground" />
                      {segment.name}
                    </Link>
                  </TableCell>
                  <TableCell>{segment._count.contacts}</TableCell>
                  <TableCell>
                    <Link href={`/contacts/segments/${segment.id}`}>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </Link>
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
