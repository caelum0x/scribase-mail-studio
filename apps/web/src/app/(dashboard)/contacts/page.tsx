"use client";

import Link from "next/link";
import AddContactBook from "./add-contact-book";
import ContactBooksList from "./contact-books-list";
import { H1 } from "@usesend/ui";
import { Button } from "@usesend/ui/src/button";
import { Tag, Layers } from "lucide-react";

export default function ContactsPage() {
  return (
    <div>
      <div className="flex justify-between items-center">
        <H1>Contact books</H1>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/contacts/segments">
              <Layers className="h-4 w-4 mr-1" />
              Segments
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/contacts/topics">
              <Tag className="h-4 w-4 mr-1" />
              Topics
            </Link>
          </Button>
          <AddContactBook />
        </div>
      </div>
      <ContactBooksList />
    </div>
  );
}
