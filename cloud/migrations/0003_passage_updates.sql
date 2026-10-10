CREATE TRIGGER passages_update AFTER UPDATE OF title,text ON passages
WHEN old.title IS NOT new.title OR old.text IS NOT new.text
BEGIN
  INSERT INTO passages_fts(passages_fts,rowid,title,text) VALUES('delete',old.rowid,old.title,old.text);
  INSERT INTO passages_fts(rowid,title,text) VALUES(new.rowid,new.title,new.text);
END;
