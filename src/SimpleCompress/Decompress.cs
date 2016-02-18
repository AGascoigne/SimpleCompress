namespace SimpleCompress
{
    using System;
    using System.IO;
    using System.IO.Compression;
    using System.Text;

    public static class Decompress
    {
        public static void FromFileToFolder(string srcFilePath, string dstPath)
        {
            const bool ifExistsOverWrite = true;

            // decompress to temp file, 
            // run through the stream, writing the data out to the first file, then copy to all duplicates
            var tmp = srcFilePath + ".tmp";

            // decompress file
            if (File.Exists(tmp))
            {
                File.Delete(tmp);
            }
            using (var compressing = new GZipStream(File.OpenRead(srcFilePath), CompressionMode.Decompress))
            {
                using (var cat = File.OpenWrite(tmp))
                {
                    compressing.CopyTo(cat, 65536);
                    cat.Flush();
                }
            }

            // scan the file
            using (var fs = File.OpenRead(tmp))
            {
                long pathsLength;
                while (ReadLength(fs, out pathsLength))
                {
                    // get all target paths
                    long fileLength;
                    var subPaths = ReadUtf8(fs, pathsLength).Split('|');
                    if (!ReadLength(fs, out fileLength)) throw new Exception("Malformed file: no length for data");

                    // read source into first file
                    var firstPath = dstPath+subPaths[0];
                    PutFolder(firstPath);
                    CopyLength(fs, firstPath, fileLength, ifExistsOverWrite);
                    if (subPaths.Length == 1)
                    {
                        continue;
                    }

                    // copy first file into all other locations
                    var srcInfo = new PathInfo(firstPath);
                    for (int i = 1; i < subPaths.Length; i++) 
                    {
                        var thisPath = dstPath + subPaths[i];
                        PutFolder(thisPath);
                        try
                        {
                            if (!NativeIO.CopyFile(srcInfo, new PathInfo(thisPath), ifExistsOverWrite))
                            {
                                Console.WriteLine("Error: failed to write " + firstPath + " to " + thisPath);
                            }
                        }
                        catch (Exception exc)
                        {
                            throw;
                        }
                    }
                }
            }

            // cleanup temp file
            File.Delete(tmp);
        }

        static void PutFolder(string path)
        {
            var pinfo = new PathInfo(path);
            if (pinfo.Parent != null) NativeIO.CreateDirectory(new PathInfo(path).Parent, recursive:true);
        }

        static void CopyLength(Stream fs, string dstFilePath, long fileLength, bool ifExistsOverWrite)
        {
            const int bufSz = 65536;
            var remain = fileLength;
            var buffer = new byte[bufSz];
            var fileMode = ifExistsOverWrite ? FileMode.Create : FileMode.CreateNew;
            using (var fout = NativeIO.OpenFileStream(new PathInfo(dstFilePath), FileAccess.Write, fileMode)) 
            {
                int len;
                while (remain > bufSz) 
                {
                    len = fs.Read(buffer, 0, bufSz);
                    if (len != bufSz) throw new Exception("Malformed file: data truncated");
                    fout.Write(buffer, 0, bufSz);
                    remain -= bufSz;
                }

                if (remain == 0)
                {
                    return;
                }

                len = fs.Read(buffer, 0, (int)remain);
                if (len != remain)
                {
                    throw new Exception("Malformed file: data truncated at end");
                }
                fout.Write(buffer, 0, (int)remain);
            }
        }

        static string ReadUtf8(Stream fs, long pathsLength)
        {
            var bytes = new byte[pathsLength];
            var len = fs.Read(bytes, 0, (int)pathsLength);
            if (len != pathsLength)
            {
                throw new Exception("Malformed file: too short in paths");
            }

            return Encoding.UTF8.GetString(bytes);
        }

        static bool ReadLength(Stream fs, out long pathsLength)
        {
            var bytes = new byte[8];
            var len = fs.Read(bytes, 0, 8);
            if (len != 8)
            {
                pathsLength = 0; 
                return false;
            }

            if (!BitConverter.IsLittleEndian)
            {
                Array.Reverse(bytes, 0, bytes.Length);
            }
            pathsLength = BitConverter.ToInt64(bytes, 0);
            return true;
        }
    }
}